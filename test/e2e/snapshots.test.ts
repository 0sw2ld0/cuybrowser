import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDaemon, type DaemonHandle } from "../../src/core/daemon.js";
import { estimateTokens } from "../../src/core/snapshot/render.js";
import { callTool } from "../../src/ipc/client.js";
import { tools } from "../../src/tools/index.js";
import { startFixtureServer } from "../fixtures/server.js";

const home = mkdtempSync(join(tmpdir(), "cb-"));
process.env.CUYBROWSER_HOME = home;

let base: string;
let fixtures: Server;
let daemon: DaemonHandle;
const decisions = { value: "denied" as "approved" | "denied" };
const call = callTool as (tool: string, params?: unknown) => Promise<any>;

async function open(page: string): Promise<void> {
  const response = await call("navigate", { url: `${base}/${page}` });
  expect(response.ok, JSON.stringify(response)).toBe(true);
}

function refIn(text: string, label: string, occurrence = 0): string {
  const lines = text.split("\n").filter((line) => line.includes(label));
  const ref = lines[occurrence]?.match(/\[((?:f\d+)?e\d+)\]/)?.[1];
  if (!ref) throw new Error(`Sin ref para "${label}" en:\n${text}`);
  return ref;
}

async function snapshotText(params: unknown = {}): Promise<string> {
  const response = await call("snapshot", params);
  expect(response.ok, JSON.stringify(response)).toBe(true);
  return response.data.text;
}

beforeAll(async () => {
  writeFileSync(join(home, "policy.yaml"), "approval: native-dialog\n");
  ({ url: base, server: fixtures } = await startFixtureServer());
  daemon = await runDaemon(tools, {
    embedded: true,
    approver: { request: async () => decisions.value },
  });
  expect((await call("start", { headless: true })).ok).toBe(true);
}, 60_000);

afterAll(async () => {
  await daemon?.close();
  fixtures?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("modo diff", () => {
  it("sin snapshot anterior devuelve el completo con diff_fallback", async () => {
    await open("widgets");
    const response = await call("snapshot", { mode: "diff" });
    expect(response.data.mode).toBe("full");
    expect(response.warnings.join(" ")).toContain("diff_fallback");
  });

  it("muestra solo los cambios y conserva las refs", async () => {
    await open("widgets");
    const full = await snapshotText();
    expect((await call("snapshot", { mode: "diff" })).data.text).toContain("(sin cambios)");

    await call("click", { ref: refIn(full, 'button "Sumar"') });
    const changed = await call("snapshot", { mode: "diff" });
    expect(changed.data.mode).toBe("diff");
    expect(changed.data.text).toContain('+ text "Clics: 1"');
    expect(changed.data.text).toContain('- text "Clics: 0"');
    expect(changed.data.text).not.toContain("Tapado");
    expect(changed.data.tokens_estimated).toBeLessThan(estimateTokens(full) / 2);

    const notes = refIn(full, '"Notas"');
    await call("type", { ref: notes, text: "-x" });
    expect((await call("snapshot", { mode: "diff" })).data.text).toContain(`~ textbox "Notas" [${notes}] value="inicial-x"`);

    const remove = refIn(full, '"Quitar sumar"');
    const add = refIn(full, 'button "Sumar"');
    await call("click", { ref: remove });
    expect((await call("snapshot", { mode: "diff" })).data.text).toContain(`- button "Sumar" [${add}]`);
  });

  it("vuelve al completo si el diff no compensa o cambió el documento o el alcance", async () => {
    await open("login");
    await snapshotText();
    await open("widgets");
    const next = await call("snapshot", { mode: "diff" });
    expect(next.data.mode).toBe("full");
    expect(next.warnings.join(" ")).toContain("diff_fallback");

    await snapshotText({ interactive_only: true });
    const scopeChanged = await call("snapshot", { mode: "diff" });
    expect(scopeChanged.data.mode).toBe("full");
  });
});

describe("presupuesto de tokens", () => {
  it("recorta una lista enorme, avisa y permite pedir una sección", async () => {
    await open("lista");
    const response = await call("snapshot");
    expect(response.data.truncated).toBe(true);
    expect(response.data.tokens_estimated).toBeLessThanOrEqual(8000);
    expect(response.warnings.join(" ")).toContain("recortado");
    expect(response.data.text).toContain('button "Último botón"');
    const hint = response.data.text.match(/elementos más, usa scope_ref=(e\d+)/);
    expect(hint).not.toBeNull();

    const scoped = await call("snapshot", { scope_ref: hint[1], max_tokens: 500 });
    expect(scoped.data.tokens_estimated).toBeLessThanOrEqual(500);
    expect(scoped.data.text).not.toContain("Último botón");
  }, 30_000);

  it("cumple el objetivo del 50 % en un artículo largo", async () => {
    await open("articulo");
    const snapshot = (await call("snapshot")).data.tokens_estimated;
    const text = estimateTokens((await call("get_text", { max_chars: 1_000_000 })).data.text);
    expect(snapshot / text).toBeLessThanOrEqual(0.5);
  });
});

describe("find", () => {
  it("ordena por coincidencia, ignora mayúsculas y acentos, y filtra por rol", async () => {
    await open("login");
    const accents = await call("find", { query: "CONTRASENA" });
    expect(accents.data.matches.map((match: any) => match.role)).toContain("textbox");

    const exact = await call("find", { query: "entrar" });
    expect(exact.data.matches[0]).toMatchObject({ role: "button", name: "Entrar" });
    expect((await call("click", { ref: "e99999" })).ok).toBe(false);

    const onlyLinks = await call("find", { query: "contraseña", role: "link" });
    expect(onlyLinks.data.total).toBe(1);
    expect(onlyLinks.data.matches[0].role).toBe("link");
    expect((await call("find", { query: "no existe en la página" })).data.matches).toEqual([]);
  });

  it("devuelve refs utilizables en páginas enormes y respeta el límite", async () => {
    await open("lista");
    const many = await call("find", { query: "producto número", limit: 3 });
    expect(many.data.matches).toHaveLength(3);
    expect(many.data.total).toBe(3000);
    const last = await call("find", { query: "último botón" });
    expect((await call("hover", { ref: last.data.matches[0].ref })).ok).toBe(true);
  }, 30_000);

  it("no busca en el valor de los campos sensibles", async () => {
    await open("login");
    expect((await call("find", { query: "secreto-precargado" })).data.total).toBe(0);
  });
});

describe("iframes", () => {
  const openFrames = async () => {
    await open("iframes");
    for (let i = 0; i < 40; i++) {
      const text = await snapshotText();
      if ((text.match(/Pulsar dentro/g) ?? []).length >= 3) return text;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(await snapshotText());
  };

  it("incluye iframes del mismo sitio y de otro sitio con refs prefijadas", async () => {
    const text = await openFrames();
    expect(text).toContain('iframe "Mismo sitio"');
    expect(text).toContain('iframe "Otro sitio"');
    expect(refIn(text, '"Pulsar dentro"', 0)).toMatch(/^f\d+e\d+$/);
    expect(refIn(text, '"Pulsar dentro"', 1)).toMatch(/^f\d+e\d+$/);
    expect(text).toMatch(/"Clave interna" \[f\d+e\d+\] \(password, SENSIBLE\)/);
  }, 30_000);

  it.each([
    ["mismo sitio", 0],
    ["otro sitio", 1],
  ])("hace clic y escribe en un iframe de %s", async (_name, occurrence) => {
    const text = await openFrames();
    const clicked = await call("click", { ref: refIn(text, '"Pulsar dentro"', occurrence) });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    const after = await snapshotText();
    expect(after).toContain('"Pulsado dentro"');

    const field = refIn(text, '"Campo interno"', occurrence);
    const typed = await call("type", { ref: field, text: "hola" });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    expect(await snapshotText()).toContain('value="hola"');
  }, 30_000);

  it("captura y lee elementos dentro de un iframe", async () => {
    const text = await openFrames();
    const ref = refIn(text, '"Pulsar dentro"', 1);
    const shot = await call("screenshot", { ref });
    expect(Buffer.from(shot.data.image.base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect((await call("find", { query: "Pulsar dentro" })).data.total).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it("no pulsa dentro de un iframe tapado por una capa de la página", async () => {
    const text = await openFrames();
    const covered = await call("click", { ref: refIn(text, '"Pulsar dentro"', 2) });
    expect(covered.error.code).toBe("NOT_INTERACTABLE");
  }, 30_000);

  it("aplica las protecciones dentro de los iframes", async () => {
    const text = await openFrames();
    const password = await call("type", { ref: refIn(text, '"Clave interna"', 1), text: "x" });
    expect(password.error.code).toBe("SENSITIVE_FIELD");
    // type enfoca el campo por CDP; Tab lleva el foco a la contraseña sin depender de un clic.
    for (const occurrence of [0, 1]) {
      expect((await call("type", { ref: refIn(text, '"Campo interno"', occurrence), text: "" })).ok).toBe(true);
      expect((await call("press_key", { key: "Tab" })).ok).toBe(true);
      expect((await call("press_key", { key: "x" })).error?.code, `iframe ${occurrence}`).toBe("SENSITIVE_FIELD");
    }

    const submit = await call("click", { ref: refIn(text, '"Enviar dentro"', 0) });
    expect(submit.error.code).toBe("CONFIRMATION_REQUIRED");

    const field = refIn(text, '"Campo interno"', 0);
    expect((await call("type", { ref: field, text: "a" })).ok).toBe(true);
    const enter = await call("press_key", { key: "Enter" });
    expect(enter.error?.code).toBe("CONFIRMATION_REQUIRED");
  }, 30_000);

  it("una navegación dentro de un iframe solo invalida sus refs", async () => {
    const text = await openFrames();
    const main = refIn(text, 'heading "Página principal"');
    const inner = refIn(text, '"Pulsar dentro"', 0);
    await call("click", { ref: refIn(text, '"Cambiar frame"', 0) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await call("click", { ref: inner })).error.code).toBe("REF_STALE");
    expect((await call("hover", { ref: main })).ok).toBe(true);
  }, 30_000);
});
