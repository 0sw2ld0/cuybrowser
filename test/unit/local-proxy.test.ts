import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { LocalNetworkProxy } from "../../src/core/security/local-proxy.js";
import { defaultPolicy } from "../../src/core/security/policy.js";

let proxy: LocalNetworkProxy | undefined;
let server: Server | undefined;
afterEach(async () => {
  await proxy?.close();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  proxy = undefined; server = undefined;
});
async function target() {
  const paths: string[] = [];
  server = createServer((req, res) => { paths.push(req.url ?? ""); res.end("propio"); });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, paths };
}
async function send(config: { server: string; username?: string; password?: string }, url: string, auth = true) {
  const endpoint = new URL(config.server);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers = auth ? { "Proxy-Authorization": "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64") } : {};
    const request = httpRequest({ host: endpoint.hostname, port: endpoint.port, path: url, headers }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    });
    request.on("error", reject); request.end();
  });
}

it("el proxy exige su secreto y no contacta un destino local no aprobado", async () => {
  const t = await target();
  proxy = new LocalNetworkProxy(() => ({ ...defaultPolicy(), local_network: { allow_origins: [] } }));
  const config = (await proxy.start())!;
  expect((await send(config, `http://127.0.0.1:${t.port}/private`, false)).status).toBe(407);
  expect((await send(config, `http://127.0.0.1:${t.port}/private`)).status).toBe(403);
  expect(t.paths).toEqual([]);
});

it("el permiso de sitio no sustituye al permiso local cuando DNS devuelve una IP privada", async () => {
  const t = await target();
  const origin = `http://public.fixture.test:${t.port}`;
  const policy = { ...defaultPolicy(), origins: { allow: [origin], deny: [] }, local_network: { allow_origins: [] as string[] } };
  let lookups = 0;
  proxy = new LocalNetworkProxy(() => policy, async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; });
  const config = (await proxy.start())!;
  expect((await send(config, origin + "/blocked")).status).toBe(403);
  expect(t.paths).toEqual([]);
  policy.local_network.allow_origins.push(origin);
  const before = lookups;
  expect(await send(config, origin + "/allowed")).toEqual({ status: 200, body: "propio" });
  expect(lookups - before).toBe(1);
  expect(t.paths).toEqual(["/allowed"]);
});
