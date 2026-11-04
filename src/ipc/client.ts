import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { ApprovalInfo } from "../core/core.js";
import type { ToolResponse } from "../core/errors.js";
import type { BrowserEvent } from "../core/events.js";
import { ensureHome, logPath, socketPath } from "../core/paths.js";
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

function startDaemon(): void {
  ensureHome();
  const log = openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, daemonArgs(), {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  closeSync(log);
}

async function openWithAutostart(): Promise<Socket> {
  try {
    return await open();
  } catch {
    startDaemon();
  }
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

export async function callTool(tool: string, params: unknown): Promise<ToolResponse> {
  try {
    const socket = await openWithAutostart();
    const reply = await exchange(socket, { id: 1, type: "tool", tool, params });
    if (reply.type !== "tool") throw new Error("Respuesta inesperada del daemon.");
    return reply.response;
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

/** No arranca el daemon: consultar o detener uno inexistente no debe crearlo. */
export async function daemonPid(): Promise<number | null> {
  try {
    const reply = await exchange(await open(), { id: 1, type: "ping" });
    return reply.type === "pong" ? reply.pid : null;
  } catch {
    return null;
  }
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
