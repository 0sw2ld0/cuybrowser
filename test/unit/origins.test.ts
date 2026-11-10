import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPolicy, hasDomainRules, isUrlAllowed, loadPolicy } from "../../src/core/security/policy.js";
import { isLocalRequestAllowed } from "../../src/core/security/local-network.js";
import { prepareRestrictedProfile } from "../../src/core/security/restricted-profile.js";

const homes: string[] = [];
function home() { const path = mkdtempSync(join(tmpdir(), "cb-origin-unit-")); homes.push(path); return path; }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
function policy(value: unknown) {
  process.env.CUYBROWSER_HOME = home();
  writeFileSync(join(process.env.CUYBROWSER_HOME, "policy.yaml"), JSON.stringify(value));
  return loadPolicy();
}

describe("política de orígenes", () => {
  it("ausente conserva compatibilidad y vacía cierra todas las navegaciones http", () => {
    expect(isUrlAllowed(defaultPolicy(), "https://example.com")).toBe(true);
    const closed = policy({ origins: { allow: [], deny: [] } });
    expect(isUrlAllowed(closed, "https://example.com")).toBe(false);
    expect(isUrlAllowed(closed, "about:blank")).toBe(true);
    expect(hasDomainRules(closed)).toBe(true);
  });
  it("normaliza puertos por defecto sin permitir cambios de esquema o puerto", () => {
    const p = policy({ origins: { allow: ["https://EXAMPLE.com:443"], deny: [] } });
    expect(p.origins!.allow).toEqual(["https://example.com"]);
    expect(isUrlAllowed(p, "https://example.com/a")).toBe(true);
    expect(isUrlAllowed(p, "http://example.com/a")).toBe(false);
    expect(isUrlAllowed(p, "https://example.com:8443/a")).toBe(false);
    expect(isUrlAllowed(p, "https://example.com@other.test/a")).toBe(false);
  });
  it("deny y las reglas de dominio se suman, nunca se sustituyen", () => {
    const p = policy({ origins: { allow: ["https://example.com", "https://other.test"], deny: ["https://other.test"] },
      domains: { deny: ["example.com"] } });
    expect(isUrlAllowed(p, "https://example.com")).toBe(false);
    expect(isUrlAllowed(p, "https://other.test")).toBe(false);
  });
  it.each(["https://example.com/path", "https://user:pass@example.com", "https://example.com?q=1",
    "https://example.com#fragment", "file:///tmp/", "*.example.com"])("rechaza un patrón que no es origen: %s", (value) => {
    expect(() => policy({ origins: { allow: [value] } })).toThrow(/política no es válida/);
  });
});

describe("red local independiente", () => {
  it.each(["http://127.0.0.1:9000", "http://127.1", "http://2130706433", "http://0x7f.1", "http://10.0.0.1",
    "http://192.168.1.2", "http://172.16.0.1", "http://100.64.0.1", "http://[::1]", "http://router", "http://x.local"])(
    "bloquea recurso privado de página pública: %s", (url) => {
      const p = policy({ local_network: { allow_origins: [] } });
      expect(isLocalRequestAllowed(p, url, "https://public.test")).toBe(false);
    });
  it("un permiso de sitio no autoriza red local y el recurso público sigue funcionando", () => {
    const p = policy({ origins: { allow: ["http://127.0.0.1:9000"] }, local_network: { allow_origins: [] } });
    expect(isLocalRequestAllowed(p, "http://127.0.0.1:9000", "https://public.test")).toBe(false);
    expect(isLocalRequestAllowed(p, "https://public.test/image.png")).toBe(true);
  });
  it("admite excepciones locales explícitas por destino o por página aprobada", () => {
    const p = policy({ local_network: { allow_origins: ["http://127.0.0.1:9000"] } });
    expect(isLocalRequestAllowed(p, "http://127.0.0.1:9000/a", "https://public.test")).toBe(true);
    expect(isLocalRequestAllowed(p, "http://10.0.0.1/a", "http://127.0.0.1:9000")).toBe(true);
    expect(isLocalRequestAllowed(p, "http://127.0.0.1:9001/a", "https://public.test")).toBe(false);
  });
});

describe("arranque del perfil propio", () => {
  it("neutraliza restauración antes del proceso sin borrar cookies ni otras preferencias", () => {
    const dir = home(); mkdirSync(join(dir, "Default"));
    writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify({ session: { restore_on_startup: 1,
      startup_urls: ["https://example.com"] }, other: { keep: true } }));
    writeFileSync(join(dir, "Default", "Cookies"), "datos ficticios");
    prepareRestrictedProfile(dir);
    const p = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
    expect(p.session).toEqual({ restore_on_startup: 5, startup_urls: [] });
    expect(p.other).toEqual({ keep: true });
    expect(readFileSync(join(dir, "Default", "Cookies"), "utf8")).toBe("datos ficticios");
  });
  it("no cambia un perfil bloqueado ni unas preferencias ilegibles", () => {
    const dir = home(); writeFileSync(join(dir, "SingletonLock"), "ficticio");
    expect(() => prepareRestrictedProfile(dir)).toThrow(/bloqueo/);
    rmSync(join(dir, "SingletonLock")); mkdirSync(join(dir, "Default"));
    writeFileSync(join(dir, "Default", "Preferences"), "JSON roto");
    expect(() => prepareRestrictedProfile(dir)).toThrow();
    expect(readFileSync(join(dir, "Default", "Preferences"), "utf8")).toBe("JSON roto");
  });
});
