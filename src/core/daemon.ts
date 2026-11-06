import { rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { lineReader, type IpcReply, type IpcRequest } from "../ipc/protocol.js";
import { Core } from "./core.js";
import { ensureHome, socketPath } from "./paths.js";
import type { AnyTool } from "./registry.js";
import { createNativeApprover, type Approver } from "./security/approver.js";
import { ensureToken } from "./security/token.js";
import { VERSION } from "./version.js";

export interface DaemonOptions {
  /** Solo las pruebas sustituyen el aprobador; no hay ninguna forma de hacerlo por configuración. */
  approver?: Approver;
  embedded?: boolean;
}

export interface DaemonHandle {
  close(): Promise<void>;
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listen(server: Server, path: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (err: NodeJS.ErrnoException) => resolve(err);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve(null);
    });
  });
}

export async function runDaemon(tools: readonly AnyTool[], options: DaemonOptions = {}): Promise<DaemonHandle> {
  ensureHome();
  // El socket queda accesible solo para el usuario.
  process.umask(0o077);
  ensureToken();

  const path = socketPath();
  const core = new Core(tools, options.approver ?? createNativeApprover());
  const idleMs = Number(process.env.CUYBROWSER_IDLE_MINUTES ?? 30) * 60_000;
  const sockets = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let closing = false;

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearTimeout(idleTimer);
    await core.shutdown().catch((err) => console.error(err));
    for (const socket of sockets) socket.destroy();
    server.close();
    if (process.platform !== "win32") rmSync(path, { force: true });
    if (!options.embedded) process.exit(0);
  };

  const resetIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), idleMs);
    idleTimer.unref();
  };

  const handle = async (socket: Socket, line: string): Promise<void> => {
    let request: IpcRequest;
    try {
      request = JSON.parse(line) as IpcRequest;
    } catch {
      socket.destroy();
      return;
    }
    const send = (reply: IpcReply) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
    };
    const { id } = request;

    switch (request.type) {
      case "ping":
        send({ id, type: "pong", pid: process.pid, version: VERSION });
        break;
      case "shutdown":
        send({ id, type: "bye" });
        void close();
        break;
      case "subscribe": {
        const unsubscribe = core.session.events.subscribe((event) => send({ id, type: "event", event }));
        socket.once("close", unsubscribe);
        break;
      }
      case "approval_info":
        send({ id, type: "approval_info", info: core.approvalInfo(request.confirmation_id) });
        break;
      case "resolve_approval":
        send({
          id,
          type: "resolved",
          error: core.resolveApproval(request.confirmation_id, request.approved, request.channel),
        });
        break;
      case "tool":
        send({ id, type: "tool", response: await core.call(request.tool, request.params) });
        break;
    }
    resetIdle();
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", lineReader((line) => void handle(socket, line)));
  });

  let error = await listen(server, path);
  if (error?.code === "EADDRINUSE") {
    if (await isAlive(path)) {
      // Otro daemon ganó la carrera de arranque.
      if (!options.embedded) process.exit(0);
      throw error;
    }
    rmSync(path, { force: true });
    error = await listen(server, path);
  }
  if (error) throw error;

  if (!options.embedded) {
    process.on("SIGTERM", () => void close());
    process.on("SIGINT", () => void close());
  }
  resetIdle();
  return { close };
}
