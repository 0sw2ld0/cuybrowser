import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Core } from "../../src/core/core.js";
import { defineTool } from "../../src/core/registry.js";
import { tools } from "../../src/tools/index.js";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.CUYBROWSER_HOME;
  home = mkdtempSync(join(tmpdir(), "cb-audit-core-"));
  process.env.CUYBROWSER_HOME = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.CUYBROWSER_HOME;
  else process.env.CUYBROWSER_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

it("el sondeo no consume descargas ni propaga sus metadatos y no toca diálogos o reglas de navegación", async () => {
  const core = new Core(tools, { request: async () => "denied" });
  try {
    await core.call("status", {});
    const before = readFileSync(join(home, "audit.jsonl"), "utf8");
    const pending = [{ confirmation_id: "CAPACIDAD_PRIVADA", filename: "NOMBRE_PRIVADO.pdf", origin: "https://pagina.test/privado?token=SECRETO", size_bytes: 1, expires_at: "2026-11-10T00:00:00Z" }];
    (core as any).newDownloads = pending;
    vi.spyOn(core.session, "running", "get").mockReturnValue(true);
    vi.spyOn(core.session, "currentTab").mockReturnValue({
      dialog: { message: () => "TEXTO_PRIVADO" }, page: { url: () => "https://pagina.test/" },
    } as any);
    const applyRules = vi.spyOn(core.session, "applyDomainRules");
    const response = await core.call("audit_recent", {});
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/PRIVADO|SECRETO|CAPACIDAD/);
    expect((core as any).newDownloads).toBe(pending);
    expect((core as any).newDownloads).toHaveLength(1);
    expect(applyRules).not.toHaveBeenCalled();
    expect(readFileSync(join(home, "audit.jsonl"), "utf8")).toBe(before);
    vi.restoreAllMocks();
  } finally { await core.shutdown(); }
});

it("una acción que termina tras cambiar de perfil queda sólo en el perfil donde comenzó", async () => {
  let begin!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { begin = resolve; });
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const slow = defineTool({ name: "accion_lenta", description: "Fixture de acción lenta", params: z.strictObject({}),
    risk: "action", concurrent: true, handler: async () => { begin(); await delayed; return {}; } });
  const core = new Core([...tools, slow], { request: async () => "denied" });
  let profile = "perfil_a";
  vi.spyOn(core.session, "auditProfile", "get").mockImplementation(() => profile);
  const pending = core.call("accion_lenta", {});
  try {
    await entered;
    profile = "perfil_b";
    await core.call("status", {});
    finish();
    expect((await pending).ok).toBe(true);
    const b = await core.call("audit_recent", {});
    expect(b).toMatchObject({ ok: true, data: { scope: { profile: "perfil_b" }, entries: [{ tool: "status" }] } });
    profile = "perfil_a";
    const a = await core.call("audit_recent", {});
    expect(a).toMatchObject({ ok: true, data: { scope: { profile: "perfil_a" }, entries: [{ tool: "accion_lenta" }] } });
  } finally { finish(); await pending; await core.shutdown(); }
});

it("el registro accesible no expone acciones de attach, tampoco después de desconectarlo", async () => {
  const core = new Core(tools, { request: async () => "denied" });
  try {
    const attached = vi.spyOn(core.session, "auditAttached", "get").mockReturnValue(true);
    await core.call("status", {});
    expect(readFileSync(join(home, "audit.jsonl"), "utf8")).toContain('"attached":true');
    expect(await core.call("audit_recent", {})).toMatchObject({ ok: true, data: { entries: [], legacy_omitted: 0 } });
    attached.mockReturnValue(false);
    expect(await core.call("audit_recent", {})).toMatchObject({ ok: true, data: { entries: [], legacy_omitted: 0 } });
  } finally { await core.shutdown(); }
});
