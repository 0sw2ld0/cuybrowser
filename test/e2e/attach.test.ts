import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDaemon, type DaemonHandle } from "../../src/core/daemon.js";
import { callTool } from "../../src/ipc/client.js";
import { tools } from "../../src/tools/index.js";
import { startFixtureServer } from "../fixtures/server.js";

const home = mkdtempSync(join(tmpdir(), "cb-"));
process.env.CUYBROWSER_HOME = home;
const call = callTool as (tool: string, params?: unknown) => Promise<any>;
const ATTACH_ENABLED = "attach:\n  enabled: true\n";

let base: string;
let fixtures: Server;
let daemon: DaemonHandle;
/** Hace de Chrome de la persona usuaria: lo abre la prueba, no CuyBrowser. */
let external: BrowserContext;
let externalDir: string;
let cdpUrl: string;

function setPolicy(yaml: string): void {
  writeFileSync(join(home, "policy.yaml"), yaml);
}

beforeAll(async () => {
  ({ url: base, server: fixtures } = await startFixtureServer());
  externalDir = mkdtempSync(join(tmpdir(), "cb-externo-"));
  external = await chromium.launchPersistentContext(externalDir, {
    channel: "chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const port = readFileSync(join(externalDir, "DevToolsActivePort"), "utf8").split("\n")[0];
  cdpUrl = `http://127.0.0.1:${port}`;
  await external.pages()[0]!.goto(`${base}/articulo`);
  daemon = await runDaemon(tools, { embedded: true, approver: { request: async () => "denied" } });
}, 60_000);

afterAll(async () => {
  await daemon?.close();
  await external?.close();
  fixtures?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
});

beforeEach(async () => {
  setPolicy("approval: native-dialog\n");
  await call("stop");
});

describe("modo attach", () => {
  it("está deshabilitado por defecto", async () => {
    const response = await call("start", { mode: "attach", cdp_url: cdpUrl });
    expect(response.error.code).toBe("BLOCKED_BY_POLICY");
    expect((await call("status")).data.running).toBe(false);
  });

  it("solo acepta un Chrome de este equipo y cdp_url solo con attach", async () => {
    setPolicy(ATTACH_ENABLED);
    for (const url of ["http://192.168.1.10:9222", "http://ejemplo.com:9222", "file:///tmp/x", "no es una url"]) {
      expect((await call("start", { mode: "attach", cdp_url: url })).error.code, url).toBe("INVALID_PARAMS");
    }
    expect((await call("start", { mode: "launch", cdp_url: cdpUrl, headless: true })).error.code).toBe(
      "INVALID_PARAMS",
    );
  });

  it("explica el fallo si no hay ningún Chrome escuchando", async () => {
    setPolicy(ATTACH_ENABLED);
    const response = await call("start", { mode: "attach", cdp_url: "http://127.0.0.1:1" });
    expect(response.error.code).toBe("NO_BROWSER");
    expect(response.error.hint).toContain("--remote-debugging-port");
  });

  it("trabaja en una pestaña propia, ve las de la persona y al parar no cierra su Chrome", async () => {
    setPolicy(ATTACH_ENABLED);
    const started = await call("start", { mode: "attach", cdp_url: cdpUrl });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    expect(started.data).toMatchObject({ running: true, mode: "attach", cdp_url: `${cdpUrl}/` });
    expect(started.data.profile).toBeUndefined();
    const own = started.data.tabs.find((tab: { active: boolean }) => tab.active);
    expect(own.url).toBe("about:blank");
    expect(started.data.tabs.some((tab: { url: string }) => tab.url.endsWith("/articulo"))).toBe(true);

    expect((await call("navigate", { url: `${base}/login` })).ok).toBe(true);
    expect((await call("snapshot")).data.text).toContain('heading "Bienvenido"');
    expect(external.pages().some((page) => page.url().endsWith("/login"))).toBe(true);

    expect((await call("stop")).data.running).toBe(false);
    const page = await external.newPage();
    await page.goto(`${base}/welcome`);
    expect(await page.title()).toBeTruthy();
    expect(external.pages().some((candidate) => candidate.url().endsWith("/articulo"))).toBe(true);
    await page.close();
  }, 30_000);

  it("retiene las descargas en cuarentena igual que en launch", async () => {
    setPolicy(ATTACH_ENABLED);
    expect((await call("start", { mode: "attach", cdp_url: cdpUrl })).ok).toBe(true);
    await call("navigate", { url: `${base}/checkout` });
    const line = ((await call("snapshot")).data.text as string)
      .split("\n")
      .find((candidate) => candidate.includes('"Descargar informe"'));
    const clicked = await call("click", { ref: line!.match(/\[(e\d+)\]/)![1] });
    let info = clicked.data.pending_download;
    for (let i = 0; !info && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const warning = (await call("status")).warnings.find((text: string) => text.includes("Descarga retenida"));
      if (warning) info = JSON.parse(warning.slice(warning.indexOf("{")));
    }
    expect(info?.filename).toBe("informe.txt");
  }, 30_000);
});
