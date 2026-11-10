import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import ipaddr from "ipaddr.js";
import type { LaunchOptions } from "playwright-core";
import { httpOrigin, isLocalHost } from "./local-network.js";
import type { Policy } from "./policy.js";

/** Proxy privado: también controla CONNECT y WebSocket, sin interceptar ni descifrar TLS. */
export class LocalNetworkProxy {
  private readonly password = randomBytes(24).toString("base64url");
  private readonly credential = Buffer.from("Basic " + Buffer.from(`cuybrowser:${this.password}`).toString("base64"));
  private readonly sockets = new Set<Duplex>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private readonly server = createServer((req, res) => {
    if (!this.authorized(req)) { res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="CuyBrowser"' }); res.end(); return; }
    void this.destination(req, false).then(({ url, address, port }) => {
      if (this.closed) throw new Error("Proxy cerrado");
      const headers = this.headers(req);
      const upstream = httpRequest({ hostname: address, port, method: req.method,
        path: url.pathname + url.search, headers, agent: false }, (reply) => {
        res.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(res);
      });
      upstream.on("socket", (socket) => this.track(socket));
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.setTimeout(30_000, () => upstream.destroy());
      req.pipe(upstream);
      req.on("aborted", () => upstream.destroy());
    }).catch(() => { res.writeHead(403); res.end("La política bloqueó el destino."); });
  });

  constructor(private readonly policy: () => Policy,
    private readonly resolve: (hostname: string) => Promise<LookupAddress[]> = (host) => lookup(host, { all: true })) {
    this.server.on("connection", (socket) => this.track(socket));
    this.server.on("connect", (req, socket, head) => this.tunnel(req, socket, head, true));
    this.server.on("upgrade", (req, socket, head) => this.tunnel(req, socket, head, false));
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  async start(): Promise<LaunchOptions["proxy"]> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as { port: number };
    return { server: `http://127.0.0.1:${address.port}`, username: "cuybrowser", password: this.password,
      bypass: "<-loopback>" };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.closing = this.server.listening
      ? new Promise<void>((resolve) => this.server.close(() => resolve())) : Promise.resolve();
    return this.closing;
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  }

  private authorized(req: IncomingMessage): boolean {
    const supplied = Buffer.from(req.headers["proxy-authorization"] ?? "");
    return supplied.length === this.credential.length && timingSafeEqual(supplied, this.credential);
  }

  private headers(req: IncomingMessage): Record<string, string | string[]> {
    const result: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !["proxy-authorization", "proxy-connection"].includes(key)) result[key] = value;
    }
    return result;
  }

  private sourceAllowed(req: IncomingMessage): boolean {
    const allow = this.policy().local_network?.allow_origins ?? [];
    const origin = typeof req.headers.origin === "string" ? httpOrigin(req.headers.origin) : null;
    const referer = typeof req.headers.referer === "string" ? httpOrigin(req.headers.referer) : null;
    return (origin !== null && allow.includes(origin)) || (referer !== null && allow.includes(referer));
  }

  private async destination(req: IncomingMessage, tunnel: boolean) {
    const url = new URL(tunnel ? `https://${req.url}` : req.url ?? "");
    if (!(tunnel ? url.protocol === "https:" : ["http:", "ws:"].includes(url.protocol)) || url.username || url.password) {
      throw new Error("Destino no permitido");
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.port === "0") throw new Error("Puerto no permitido");
    const addresses = await this.resolve(host);
    if (this.closed) throw new Error("Proxy cerrado");
    if (!addresses.length) throw new Error("Sin dirección");
    // Resolver una vez y conectar a esa IP evita que el segundo DNS cambie el destino validado.
    const local = isLocalHost(url.hostname) || addresses.some(({ address }) => ipaddr.process(address).range() !== "unicast");
    const allowed = this.policy().local_network?.allow_origins ?? [];
    // CONNECT también transporta ws://: no revela el esquema. El permiso de red local es host:puerto,
    // independiente del permiso de sitio (que CDP sigue comprobando con el esquema completo).
    const authority = tunnel && allowed.some((origin) => {
      const approved = new URL(origin);
      return approved.hostname === url.hostname
        && Number(approved.port || (approved.protocol === "https:" ? 443 : 80)) === Number(url.port || 443);
    });
    const approved = allowed.includes(httpOrigin(url.href) ?? "") || authority || (!tunnel && this.sourceAllowed(req));
    if (this.policy().local_network && local && !approved) throw new Error("Red local no aprobada");
    const address = addresses.find((entry) => entry.family === 4)?.address ?? addresses[0]!.address;
    return { url, address, port: Number(url.port || (tunnel || url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80)) };
  }

  private tunnel(req: IncomingMessage, socket: Duplex, head: Buffer, tunnel: boolean): void {
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="CuyBrowser"\r\n\r\n');
      return;
    }
    void this.destination(req, tunnel).then(({ url, address, port }) => {
      if (this.closed) throw new Error("Proxy cerrado");
      const upstream = connect({ host: address, port }); this.track(upstream);
      upstream.once("connect", () => {
        if (tunnel) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        else {
          const headers = Object.entries(this.headers(req)).flatMap(([name, value]) =>
            Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]);
          upstream.write(`${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
        }
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
      upstream.on("error", () => socket.destroy()); socket.once("close", () => upstream.destroy());
    }).catch(() => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  }
}
