import { createServer, type Server } from "node:http";
import { createSocket } from "node:dgram";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Session } from "../../src/core/session.js";
import { navigateTab } from "../../src/core/navigation.js";
import { defaultPolicy, type Policy } from "../../src/core/security/policy.js";

const home = mkdtempSync(join(tmpdir(), "cb-origins-"));
process.env.CUYBROWSER_HOME = home;
let source: Server;
let target: Server;
let base: string;
let denied: string;
let hits = 0;
let hitPaths: string[] = [];
let sourceHits = 0;
let sourceUpgrades = 0;
let session: Session | undefined;
const listen = (server: Server) => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => {
  resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
}));

beforeAll(async () => {
  target = createServer((_req, res) => { hits++; hitPaths.push(_req.url ?? ""); res.end("No debe contactarse"); });
  target.on("upgrade", (_req, socket) => { hits++; hitPaths.push(_req.url ?? ""); socket.destroy(); });
  denied = await listen(target);
  source = createServer((req, res) => {
    sourceHits++;
    if (req.url === "/redirect") { res.writeHead(302, { location: denied + "/destino" }); res.end(); }
    else { res.setHeader("content-type", "text/html"); res.end("<title>Origen propio</title>"); }
  });
  source.on("upgrade", (_req, socket) => { sourceUpgrades++; socket.destroy(); });
  base = await listen(source);
});
afterEach(async () => { await session?.stop(); session = undefined; });
afterAll(async () => {
  await Promise.all([new Promise<void>((r) => source.close(() => r())), new Promise<void>((r) => target.close(() => r()))]);
  rmSync(home, { recursive: true, force: true });
});
async function start(allow = [base], local = [base]): Promise<Policy> {
  const policy = { ...defaultPolicy(), origins: { allow, deny: [] }, local_network: { allow_origins: local } };
  session = new Session();
  await session.applyDomainRules(policy);
  await session.start({ mode: "launch", profile: "origin-tests", headless: true });
  hits = 0; hitPaths = [];
  return policy;
}
const pause = () => new Promise((r) => setTimeout(r, 150));

describe("orígenes completos antes del contacto", () => {
  it("bloquea un redirect al mismo host en otro puerto antes de contactar al destino", async () => {
    const policy = await start();
    await expect(navigateTab(session!.activeTab(), base + "/redirect", "domcontentloaded", policy))
      .rejects.toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });

  it("una lista de orígenes presente y vacía no permite navegar", async () => {
    const policy = await start([]);
    await expect(navigateTab(session!.activeTab(), base, "domcontentloaded", policy))
      .rejects.toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect(session!.activeTab().page.url()).toBe("about:blank");
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });

  it("prepara las pestañas explícitas y bloquea frames de otro origen sin contacto", async () => {
    const policy = await start([base, denied]);
    const tab = await session!.newTab();
    await navigateTab(tab, base, "domcontentloaded", policy);
    await tab.page.evaluate((url) => { const frame = document.createElement("iframe"); frame.src = url; document.body.append(frame); }, denied);
    await pause();
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });

  it("bloquea una ventana de la página que intenta salir del origen", async () => {
    const policy = await start();
    const tab = session!.activeTab();
    await navigateTab(tab, base, "domcontentloaded", policy);
    await tab.page.evaluate((url) => window.open(url), denied);
    await pause();
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });

  it("protege recursos, workers y sockets de una página pública", async () => {
    const publicOrigin = "https://public.fixture.test";
    const policy = await start([publicOrigin], []);
    const tab = session!.activeTab();
    await tab.page.context().grantPermissions(["local-network-access"], { origin: publicOrigin });
    await tab.page.context().route(publicOrigin + "/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/worker.js") {
        await route.fulfill({ contentType: "text/javascript", body: `postMessage("running"); fetch("/worker-redirect").then(()=>postMessage("unsafe"),()=>postMessage("blocked"))` });
      } else if (path === "/worker-redirect") {
        await route.fulfill({ status: 302, headers: { location: denied + "/worker" } });
      } else await route.fulfill({ contentType: "text/html", body: "<title>Página pública ficticia</title>" });
    });
    await navigateTab(tab, publicOrigin, "domcontentloaded", policy);
    const outcome = await tab.page.evaluate(async (url) => {
      const request = fetch(url + "/fetch").then(() => "unsafe", () => "blocked");
      const worker = new Promise<string>((resolve) => {
        let running = false;
        const worker = new Worker("/worker.js");
        worker.onmessage = (event) => {
          if (event.data === "running") { running = true; return; }
          worker.terminate(); resolve(running ? event.data : "not-running");
        };
        worker.onerror = () => resolve("closed");
        setTimeout(() => { worker.terminate(); resolve("closed"); }, 1500);
      });
      const socket = new Promise<string>((resolve) => {
        const socket = new WebSocket(url.replace("http:", "ws:") + "/socket");
        socket.onerror = () => resolve("blocked");
        socket.onopen = () => { socket.close(); resolve("unsafe"); };
        setTimeout(() => { socket.close(); resolve("closed"); }, 1500);
      });
      return Promise.all([request, worker, socket]);
    }, denied);
    expect(outcome).not.toContain("unsafe");
    expect(["closed", "blocked"]).toContain(outcome[1]);
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });

  it("permite un socket de origen local aprobado sin abrir otros destinos", async () => {
    const policy = await start();
    const tab = session!.activeTab();
    await navigateTab(tab, base, "domcontentloaded", policy);
    const before = sourceUpgrades;
    await tab.page.evaluate((url) => new Promise<void>((resolve) => {
      const socket = new WebSocket(url.replace("http:", "ws:") + "/propio");
      socket.onerror = () => resolve(); setTimeout(() => { socket.close(); resolve(); }, 1500);
    }), base);
    expect(sourceUpgrades).toBe(before + 1);
    expect(hits).toBe(0);
  });

  it("impide UDP WebRTC fuera del proxy, con control positivo del receptor STUN", async () => {
    const udp = createSocket("udp4");
    let packets = 0;
    udp.on("message", () => { packets++; });
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const port = udp.address().port;
    const publicOrigin = "https://public.fixture.test";
    async function stun(policy: Policy) {
      const tab = session!.activeTab();
      await tab.page.context().route(publicOrigin + "/**", (route) => route.fulfill({
        contentType: "text/html", body: "<title>Prueba propia STUN</title>",
      }));
      await navigateTab(tab, publicOrigin, "domcontentloaded", policy);
      await tab.page.evaluate(async (port) => {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
        try {
          peer.createDataChannel("prueba");
          await peer.setLocalDescription(await peer.createOffer());
          await new Promise((resolve) => setTimeout(resolve, 1200));
        } finally { peer.close(); }
      }, port);
    }
    try {
      session = new Session();
      await session.start({ mode: "launch", profile: "udp-control", headless: true });
      await stun(defaultPolicy());
      expect(packets).toBeGreaterThan(0); // El cero posterior debe probar la barrera, no un receptor inútil.
      await session.stop();
      const policy = await start([publicOrigin], []);
      packets = 0;
      await stun(policy);
      expect(packets).toBe(0);
    } finally { udp.close(); }
  });

  it("consume la visita al abandonar el origen y rechaza un snapshot atrasado", async () => {
    const policy = await start([denied], [base, denied]);
    policy.origins!.visit = { id: "visita-ficticia", origin: base };
    await session!.applyDomainRules(policy);
    const tab = session!.activeTab();
    await navigateTab(tab, base, "domcontentloaded", policy);
    await expect(navigateTab(tab, "https://not-permitted.test", "domcontentloaded", policy))
      .rejects.toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect((await session!.status()).consumed_visits).toEqual([]);
    await navigateTab(tab, denied, "domcontentloaded", policy);
    expect((await session!.status()).consumed_visits).toContain("visita-ficticia");
    await session!.applyDomainRules(policy); // mismo archivo de política antes de retirar el lease
    sourceHits = 0;
    await expect(navigateTab(tab, base, "domcontentloaded", policy)).rejects.toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect(sourceHits).toBe(0);
  });

  it("reinicia el perfil sin restaurar tráfico de la página anterior", async () => {
    let policy = await start();
    await navigateTab(session!.activeTab(), base, "domcontentloaded", policy);
    await session!.stop();
    sourceHits = 0;
    // La persona pudo configurar restauración en el perfil propio: el arranque debe neutralizarla antes.
    const profiles = join(home, "profiles");
    const candidates = readdirSync(profiles, { recursive: true, encoding: "utf8" });
    const preferencesPath = candidates.find((path) => path.endsWith(join("Default", "Preferences")));
    expect(preferencesPath).toBeDefined();
    const path = join(profiles, preferencesPath!);
    const preferences = JSON.parse(readFileSync(path, "utf8"));
    preferences.session = { restore_on_startup: 1, startup_urls: [base, denied] };
    writeFileSync(path, JSON.stringify(preferences));
    policy = await start([], []);
    await pause();
    expect(session!.activeTab().page.url()).toBe("about:blank");
    expect(sourceHits).toBe(0);
    expect(hits, JSON.stringify(hitPaths)).toBe(0);
  });
});
