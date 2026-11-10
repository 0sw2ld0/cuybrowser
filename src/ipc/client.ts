import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { ApprovalInfo } from "../core/core.js";
import type { ToolResponse } from "../core/errors.js";
import type { BrowserEvent } from "../core/events.js";
import { ensureHome, logPath, socketPath } from "../core/paths.js";
import { VERSION } from "../core/version.js";
import { lineReader, type IpcReply, type IpcRequest } from "./protocol.js";

const AUTOSTART_TIMEOUT_MS = 10_000;

function open(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath());
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Un binario compilado no tiene archivos sueltos: el daemon se lanza con el propio binario. */
function daemonArgs(): string[] {
  const here = import.meta.url;
  if (here.includes("$bunfs") || here.includes("~BUN")) return ["__daemon"];
  return [fileURLToPath(new URL("../core/daemon-main.js", here))];
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Se rota al arrancar, cuando ningún daemon tiene el archivo abierto. Se conserva el anterior como .1. */
function rotateLog(): void {
  try {
    if (statSync(logPath()).size > MAX_LOG_BYTES) renameSync(logPath(), `${logPath()}.1`);
  } catch {
    // Sin log previo no hay nada que rotar.
  }
}

function startDaemon(): void {
  ensureHome();
  rotateLog();
  const log = openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, daemonArgs(), {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
}

/** Compara versiones x.y.z. Sin versión, el daemon es anterior a esta comprobación y cuenta como más antiguo. */
export function isOlderVersion(version: string | undefined, than: string): boolean {
  if (!version) return true;
  const parts = (value: string) => value.split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

let versionChecked = false;
let restartNotice: string | null = null;

/**
 * Tras actualizar, el daemon anterior seguiría sirviendo el código viejo: se reinicia una vez por proceso.
 * Uno más nuevo se respeta, para que un cliente viejo y uno nuevo no se reinicien el daemon entre sí.
 */
async function replaceIfOutdated(socket: Socket): Promise<Socket | null> {
  if (versionChecked) return socket;
  versionChecked = true;
  const info = await daemonInfo();
  if (!info || !isOlderVersion(info.version, VERSION)) return socket;
  socket.destroy();
  await stopDaemon();
  restartNotice =
    `Se reinició el daemon de la versión ${info.version ?? "anterior"} para usar la ${VERSION}. ` +
    "El navegador se cerró: si hace falta, vuelve a ejecutar start.";
  return null;
}

async function openWithAutostart(): Promise<Socket> {
  try {
    const socket = await replaceIfOutdated(await open());
    if (socket) return socket;
  } catch {
    // No hay daemon: el que se arranca aquí es de esta misma versión.
  }
  versionChecked = true;
  startDaemon();
  const deadline = Date.now() + AUTOSTART_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await open();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`No se pudo iniciar el daemon: ${String(lastError)}. Consulta ${logPath()}.`);
}

function exchange(socket: Socket, request: IpcRequest): Promise<IpcReply> {
  return new Promise((resolve, reject) => {
    socket.setEncoding("utf8");
    const read = lineReader((line) => {
      resolve(JSON.parse(line) as IpcReply);
      socket.end();
    });
    socket.on("data", read);
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("El daemon cerró la conexión.")));
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

/**
 * CUYBROWSER_BROWSER se lee aquí, en quien llama, y no en el daemon: el daemon pudo arrancar
 * antes, desde otro proceso con otro entorno.
 */
export function withClientDefaults(tool: string, params: unknown): unknown {
  const browser = process.env.CUYBROWSER_BROWSER?.trim();
  if (tool !== "start" || !browser) return params;
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  if (record.browser !== undefined || record.mode === "attach") return params;
  return { ...record, browser };
}

export async function callTool(tool: string, params: unknown): Promise<ToolResponse> {
  try {
    const socket = await openWithAutostart();
    const reply = await exchange(socket, { id: 1, type: "tool", tool, params: withClientDefaults(tool, params) });
    if (reply.type !== "tool") throw new Error("Respuesta inesperada del daemon.");
    return withRestartNotice(reply.response);
  } catch (err) {
    return {
      ok: false,
      error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Recibe eventos hasta llamar a la función devuelta o hasta que el daemon se detenga. */
export async function subscribeEvents(
  onEvent: (event: BrowserEvent) => void,
  onClose: () => void,
): Promise<() => void> {
  const socket = await openWithAutostart();
  socket.setEncoding("utf8");
  socket.on(
    "data",
    lineReader((line) => {
      const reply = JSON.parse(line) as IpcReply;
      if (reply.type === "event") onEvent(reply.event);
    }),
  );
  socket.on("error", () => {});
  socket.once("close", onClose);
  const request: IpcRequest = { id: 1, type: "subscribe" };
  socket.write(`${JSON.stringify(request)}\n`);
  return () => socket.destroy();
}

export async function approvalInfo(confirmationId: string): Promise<ApprovalInfo> {
  const reply = await exchange(await openWithAutostart(), {
    id: 1,
    type: "approval_info",
    confirmation_id: confirmationId,
  });
  if (reply.type !== "approval_info") throw new Error("Respuesta inesperada del daemon.");
  return reply.info;
}

/** Devuelve el motivo si la respuesta no se aceptó. */
export async function resolveApproval(
  confirmationId: string,
  approved: boolean,
  channel: "cli" | "elicitation",
): Promise<string | null> {
  const reply = await exchange(await open(), {
    id: 1,
    type: "resolve_approval",
    confirmation_id: confirmationId,
    approved,
    channel,
  });
  if (reply.type !== "resolved") throw new Error("Respuesta inesperada del daemon.");
  return reply.error;
}

/** El aviso de reinicio llega una sola vez, en la primera respuesta después de reiniciar. */
function withRestartNotice(response: ToolResponse): ToolResponse {
  const notice = restartNotice;
  if (!notice) return response;
  restartNotice = null;
  if (response.ok) return { ...response, warnings: [notice, ...response.warnings] };
  const hint = response.error.hint ? `${notice} ${response.error.hint}` : notice;
  return { ...response, error: { ...response.error, hint } };
}

/** No arranca el daemon: consultar o detener uno inexistente no debe crearlo. */
export async function daemonInfo(): Promise<{ pid: number; version: string | undefined } | null> {
  try {
    const reply = await exchange(await open(), { id: 1, type: "ping" });
    return reply.type === "pong" ? { pid: reply.pid, version: reply.version } : null;
  } catch {
    return null;
  }
}

export async function daemonPid(): Promise<number | null> {
  return (await daemonInfo())?.pid ?? null;
}

export async function stopDaemon(): Promise<boolean> {
  try {
    await exchange(await open(), { id: 1, type: "shutdown" });
    // El daemon responde antes de cerrar Chrome: un arranque inmediato chocaría con el que se va.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && (await daemonPid()) !== null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  } catch {
    return false;
  }
}
