import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, stopDaemon } from "../../src/ipc/client.js";
import { startFixtureServer } from "../fixtures/server.js";

// Con CUYBROWSER_TEST_BIN, las mismas pruebas se ejecutan contra un binario compilado.
const BIN = process.env.CUYBROWSER_TEST_BIN;
const JS_ENTRY = fileURLToPath(new URL("../../dist/adapters/cli.js", import.meta.url));
const COMMAND = BIN ?? process.execPath;
const prefixArgs = BIN ? [] : [JS_ENTRY];
const home = mkdtempSync(join(tmpdir(), "cb-"));
const env = { ...process.env, CUYBROWSER_HOME: home };

let base: string;
let server: Server;

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(COMMAND, [...prefixArgs, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function json(...args: string[]) {
  const { stdout } = await cli(...args, "--json");
  return JSON.parse(stdout);
}

async function refOf(label: string): Promise<string> {
  const { stdout } = await cli("snapshot");
  const line = stdout.split("\n").find((candidate) => candidate.includes(label));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`Sin ref para "${label}" en:\n${stdout}`);
  return ref;
}

beforeAll(async () => {
  process.env.CUYBROWSER_HOME = home;
  // Las confirmaciones tienen sus propias pruebas en security.test.ts.
  writeFileSync(join(home, "policy.yaml"), "confirm: []\n");
  ({ url: base, server } = await startFixtureServer());
  const started = await json("start", "--headless");
  expect(started.ok, JSON.stringify(started)).toBe(true);
}, 60_000);

afterAll(async () => {
  await stopDaemon();
  server?.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(home, { recursive: true, force: true });
});

describe("CLI contra Chrome real", () => {
  it("rechaza un esquema no permitido", async () => {
    const response = await json("navigate", "javascript:alert(1)");
    expect(response.error.code).toBe("INVALID_PARAMS");
  });

  it("navega y genera el snapshot con el formato acordado sin filtrar la contraseña", async () => {
    const navigated = await json("navigate", `${base}/login`);
    expect(navigated.data.title).toBe("Iniciar sesión");

    const { stdout, code } = await cli("snapshot");
    expect(code).toBe(0);
    expect(stdout).toMatch(/^# .*\/login — "Iniciar sesión"/m);
    expect(stdout).toMatch(/heading "Bienvenido" \[e\d+\]/);
    expect(stdout).toMatch(/textbox "Correo" \[e\d+\] value=""/);
    expect(stdout).toMatch(/textbox "Contraseña" \[e\d+\] \(password, SENSIBLE\)/);
    expect(stdout).toMatch(/checkbox "Recordarme" \[e\d+\] checked=false/);
    expect(stdout).toMatch(/link "¿Olvidaste tu contraseña\?" \[e\d+\] → \/reset/);
    expect(stdout).not.toContain("secreto-precargado");
    expect(stdout).not.toContain("Botón oculto");
  });

  it("bloquea la escritura en un campo de contraseña", async () => {
    const ref = await refOf('"Contraseña"');
    const result = await cli("type", ref, "abc");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SENSITIVE_FIELD");
  });

  it("escribe, envía el formulario e invalida las refs anteriores", async () => {
    await cli("navigate", `${base}/login`);
    const email = await refOf('"Correo"');
    const typed = await json("type", email, "hola@correo.com");
    expect(typed.ok).toBe(true);
    expect((await cli("snapshot")).stdout).toContain('value="hola@correo.com"');

    const submit = await refOf('button "Entrar"');
    const clicked = await json("click", submit);
    expect(clicked.data.navigated).toBe(true);
    expect(clicked.data.url).toContain("/welcome?email=hola%40correo.com");

    const stale = await json("click", submit);
    expect(stale.error.code).toBe("REF_STALE");
    expect((await json("click", "e9999")).error.code).toBe("REF_NOT_FOUND");
  });

  it("type --clear reemplaza y type --submit navega", async () => {
    await cli("navigate", `${base}/widgets`);
    const notes = await refOf('"Notas"');
    expect((await cli("type", notes, "--", "-extra")).code).toBe(0);
    expect((await cli("snapshot")).stdout).toContain('value="inicial-extra"');
    await cli("type", notes, "nuevo", "--clear");
    expect((await cli("snapshot")).stdout).toContain('value="nuevo"');

    await cli("navigate", `${base}/login`);
    const email = await refOf('"Correo"');
    const submitted = await json("type", email, "a@b.c", "--submit");
    expect(submitted.data.navigated).toBe(true);
  });

  it("hace clic sin navegar, y dentro de shadow DOM abierto", async () => {
    await cli("navigate", `${base}/widgets`);
    const clicked = await json("click", await refOf('button "Sumar"'));
    expect(clicked.data.navigated).toBe(false);
    expect((await cli("snapshot")).stdout).toContain("Clics: 1");

    await json("click", await refOf('"Dentro de shadow"'));
    expect((await cli("snapshot")).stdout).toContain("Shadow pulsado");
  });

  it("no pulsa un elemento tapado ni uno deshabilitado", async () => {
    await cli("navigate", `${base}/widgets`);
    const covered = await json("click", await refOf('button "Tapado"'));
    expect(covered.error.code).toBe("NOT_INTERACTABLE");
    expect((await cli("snapshot")).stdout).not.toContain("TAPADO PULSADO");
    const disabled = await json("click", await refOf('button "Inactivo"'));
    expect(disabled.error.code).toBe("NOT_INTERACTABLE");
  });

  it("devuelve REF_STALE si el nodo se elimina, y pushState conserva las refs", async () => {
    await cli("navigate", `${base}/widgets`);
    const add = await refOf('button "Sumar"');
    await json("click", await refOf('"Cambiar URL"'));
    expect((await refOf('button "Sumar"'))).toBe(add);
    await json("click", await refOf('"Quitar sumar"'));
    expect((await json("click", add)).error.code).toBe("REF_STALE");
  });

  it("limita el snapshot con --scope y --interactive-only", async () => {
    await cli("navigate", `${base}/login`);
    const form = await refOf("- form");
    const scoped = (await cli("snapshot", "--scope", form)).stdout;
    expect(scoped).toContain('"Correo"');
    expect(scoped).not.toContain("Bienvenido");
    const interactive = (await cli("snapshot", "--interactive-only")).stdout;
    expect(interactive).toContain('button "Entrar"');
    expect(interactive).not.toContain("heading");
  });

  it("guarda capturas como PNG", async () => {
    await cli("navigate", `${base}/login`);
    const out = join(home, "captura.png");
    const page = await json("screenshot", "--out", out);
    expect(page.data.path).toBe(out);
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");

    const element = await json("screenshot", "--ref", await refOf('button "Entrar"'), "--base64");
    const bytes = Buffer.from(element.data.image.base64, "base64");
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.length).toBeLessThan(readFileSync(out).length);
  });

  it("gestiona pestañas e informa de las que abre un clic", async () => {
    await cli("navigate", `${base}/widgets`);
    const opened = await json("click", await refOf('"Abrir aparte"'));
    expect(opened.data.new_tabs).toHaveLength(1);
    await json("tab_close", opened.data.new_tabs[0]);

    const created = await json("tab_new", `${base}/reset`);
    expect((await cli("snapshot")).stdout).toContain("Recupera tu contraseña");
    const { data } = await json("tabs_list");
    const other = data.tabs.find((tab: { id: string }) => tab.id !== created.data.id);
    await json("tab_select", other.id);
    expect((await cli("snapshot")).stdout).toContain("Sumar");
    await json("tab_close", created.data.id);
    expect((await json("tabs_list")).data.tabs).toHaveLength(1);
    expect((await json("tab_select", "t999")).error.code).toBe("NO_TAB");
  });

  it("valida parámetros y responde NO_BROWSER cuando Chrome está cerrado", async () => {
    expect((await json("click")).error.code).toBe("INVALID_PARAMS");
    expect((await json("stop")).ok).toBe(true);
    expect((await json("snapshot")).error.code).toBe("NO_BROWSER");
    expect((await json("status")).data.running).toBe(false);
    expect((await json("start", "--headless")).ok).toBe(true);
  }, 30_000);

  it("mantiene la latencia mediana de click por debajo de 300 ms", async () => {
    await cli("navigate", `${base}/widgets`);
    const ref = await refOf('button "Sumar"');
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      const response = await callTool("click", { ref });
      samples.push(performance.now() - start);
      expect(response.ok).toBe(true);
    }
    samples.sort((a, b) => a - b);
    expect(samples[7]).toBeLessThan(300);
  }, 30_000);

  it("arranca un solo daemon y lo detiene con su socket", async () => {
    const results = await Promise.all([cli("daemon", "status"), cli("status")]);
    expect(results[0].stdout).toContain("en marcha");
    expect((await cli("daemon", "stop")).stdout).toContain("detenido");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(home, "daemon.sock"))).toBe(false);
    expect((await cli("daemon", "status")).stdout).toContain("detenido");
  }, 30_000);
});
