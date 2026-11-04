import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolError } from "../core/errors.js";
import type { AnyTool } from "../core/registry.js";
import { toolInputSchema } from "../core/schema.js";
import { readToken } from "../core/security/token.js";
import { callTool, subscribeEvents } from "../ipc/client.js";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: ToolError): void {
  sendJson(res, status, { ok: false, error });
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const received = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too_large"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function streamEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
  });
  res.write(": conectado\n\n");
  const close = await subscribeEvents(
    (event) => res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
    () => res.end(),
  );
  req.once("close", close);
}

export async function runHttp(tools: readonly AnyTool[], port: number): Promise<void> {
  // Consultar el estado arranca el daemon, que es quien genera el token.
  const status = await callTool("status", {});
  if (!status.ok) throw new Error(status.error.message);
  const token = readToken();

  const server = createServer(async (req, res) => {
    try {
      // Ninguna página web puede llamar a la API: los navegadores envían Origin en estas peticiones.
      if (req.headers.origin !== undefined) {
        sendError(res, 403, { code: "BLOCKED_BY_POLICY", message: "No se aceptan peticiones con Origin." });
        return;
      }
      const actualPort = (server.address() as AddressInfo).port;
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!allowedHosts.includes(req.headers.host ?? "")) {
        sendError(res, 403, { code: "BLOCKED_BY_POLICY", message: "Cabecera Host no permitida." });
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        sendError(res, 401, { code: "BLOCKED_BY_POLICY", message: "Token ausente o incorrecto." });
        return;
      }

      const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
      if (req.method === "GET" && pathname === "/v1/tools") {
        sendJson(res, 200, {
          ok: true,
          data: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              risk: tool.risk,
              input_schema: toolInputSchema(tool),
            })),
          },
          warnings: [],
        });
        return;
      }
      if (req.method === "GET" && pathname === "/v1/events") {
        await streamEvents(req, res);
        return;
      }

      const match = pathname.match(/^\/v1\/tools\/([a-z_]+)$/);
      if (!match || !tools.some((tool) => tool.name === match[1])) {
        sendError(res, 404, { code: "INVALID_PARAMS", message: "Ruta no encontrada." });
        return;
      }
      if (req.method !== "POST") {
        sendError(res, 405, { code: "INVALID_PARAMS", message: "Usa POST." });
        return;
      }

      let params: unknown = {};
      const body = await readBody(req);
      if (body.trim()) {
        try {
          params = JSON.parse(body);
        } catch {
          sendError(res, 400, { code: "INVALID_PARAMS", message: "El cuerpo no es JSON válido." });
          return;
        }
      }
      sendJson(res, 200, await callTool(match[1]!, params));
    } catch (err) {
      if (res.headersSent) {
        res.end();
      } else if (err instanceof Error && err.message === "too_large") {
        sendError(res, 413, { code: "INVALID_PARAMS", message: "El cuerpo es demasiado grande." });
      } else {
        sendError(res, 500, { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, resolve);
  });
  console.log(`API HTTP en http://${HOST}:${(server.address() as AddressInfo).port}`);
}
