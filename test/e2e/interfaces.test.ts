import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "../fixtures/server.js";

// Con CUYBROWSER_TEST_BIN, las mismas pruebas se ejecutan contra un binario compilado.
const BIN = process.env.CUYBROWSER_TEST_BIN;
const JS_ENTRY = fileURLToPath(new URL("../../dist/adapters/cli.js", import.meta.url));
const COMMAND = BIN ?? process.execPath;
const prefixArgs = BIN ? [] : [JS_ENTRY];
const home = mkdtempSync(join(tmpdir(), "cb-"));
const env = { ...process.env, CUYBROWSER_HOME: home } as Record<string, string>;

type Params = Record<string, unknown>;
type Call = (tool: string, params?: Params) => Promise<any>;

let base: string;
let fixtures: Server;
let serve: ChildProcess;
let httpUrl: string;
let token: string;
let mcp: Client;

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(COMMAND, [...prefixArgs, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const viaCli: Call = async (tool, params = {}) => {
  const args = [tool, "--json"];
  for (const [name, value] of Object.entries(params)) {
    const flag = `--${name.replace(/_/g, "-")}`;
    if (value === true) args.push(flag);
    else args.push(flag, String(value));
  }
  return JSON.parse((await runCli(args)).stdout);
};

const viaHttp: Call = async (tool, params = {}) => {
  const res = await fetch(`${httpUrl}/v1/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  return res.json();
};

const viaMcp: Call = async (tool, params = {}) => {
  const result = (await mcp.callTool({ name: `browser_${tool}`, arguments: params })) as {
    content: { type: string; text?: string; data?: string; mimeType?: string }[];
  };
  const first = result.content[0]!;
  if (first.type === "image") {
    return { ok: true, data: { image: { mime_type: first.mimeType, base64: first.data } }, warnings: [] };
  }
  try {
    return JSON.parse(first.text!);
  } catch {
    return { ok: true, data: { text: first.text }, warnings: [] };
  }
};

/** Las refs y los ids de pestaña avanzan entre ejecuciones; el resto debe coincidir exactamente. */
function normalize(response: any): string {
  const copy = structuredClone(response);
  if (typeof copy.data?.text === "string") copy.data = { text: copy.data.text };
  return JSON.stringify(copy)
    .replace(/\be\d+\b/g, "eN")
    .replace(/"confirmation_id":"[0-9a-f]+"/g, '"confirmation_id":"ID"')
    .replace(/"expires_at":"[^"]+"/g, '"expires_at":"FECHA"')
    .replace(/\bt\d+\b/g, "tN");
}

function refIn(snapshot: any, label: string): string {
  const line = (snapshot.data.text as string).split("\n").find((candidate) => candidate.includes(label));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`Sin ref para "${label}" en:\n${snapshot.data.text}`);
  return ref;
}

async function scenario(call: Call): Promise<string[]> {
  const log: string[] = [];
  const step: Call = async (tool, params) => {
    const response = await call(tool, params);
    log.push(`${tool}: ${normalize(response)}`);
    return response;
  };
  await step("navigate", { url: `${base}/login` });
  const login = await step("snapshot");
  await step("type", { ref: refIn(login, '"Correo"'), text: "a@b.c" });
  await step("type", { ref: refIn(login, '"Contraseña"'), text: "x" });
  await step("get_text");
  await step("wait_for", { text: "Bienvenido" });
  await step("wait_for", { text: "No aparece", timeout_ms: 100 });
  await step("hover", { ref: refIn(login, '"Entrar"') });
  await step("press_key", { key: "Tab" });
  await step("click", { ref: "e99999" });
  await step("click");
  await step("navigate", { url: "file:///etc/passwd" });
  await step("click", { ref: refIn(login, '"Entrar"') });
  await step("back");
  await step("forward");
  await step("reload");
  await step("navigate", { url: `${base}/wizard` });
  const wizard = await step("snapshot", { interactive_only: true });
  await step("type", { ref: refIn(wizard, '"Nombre"'), text: "Ana", submit: true });
  const paso2 = await step("snapshot");
  await step("select_option", { ref: refIn(paso2, '"País"'), label: "Perú" });
  await step("select_option", { ref: refIn(paso2, '"País"'), label: "Chile" });
  await step("scroll", { direction: "down", amount: 10 });
  await step("tabs_list");
  await step("status");
  return log;
}

beforeAll(async () => {
  // Las confirmaciones tienen sus propias pruebas en security.test.ts.
  writeFileSync(join(home, "policy.yaml"), "confirm: []\n");
  ({ url: base, server: fixtures } = await startFixtureServer());
  const started = await viaCli("start", { headless: true });
  expect(started.ok, JSON.stringify(started)).toBe(true);

  serve = spawn(COMMAND, [...prefixArgs, "serve", "--http", "--port", "0"], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  httpUrl = await new Promise((resolve, reject) => {
    serve.stdout!.once("data", (chunk) => {
      const url = String(chunk).match(/http:\/\/\S+/)?.[0];
      if (url) resolve(url);
      else reject(new Error(String(chunk)));
    });
  });
  token = readFileSync(join(home, "token"), "utf8").trim();

  mcp = new Client({ name: "pruebas", version: "1.0.0" });
  await mcp.connect(new StdioClientTransport({ command: COMMAND, args: [...prefixArgs, "mcp"], env }));
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  serve?.kill();
  await runCli(["daemon", "stop"]);
  fixtures?.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(home, { recursive: true, force: true });
});

describe("paridad entre interfaces", () => {
  it("expone las mismas herramientas con el mismo esquema", async () => {
    const { tools: mcpTools } = await mcp.listTools();
    const http = await fetch(`${httpUrl}/v1/tools`, { headers: { authorization: `Bearer ${token}` } }).then((r) =>
      r.json(),
    );
    const fromMcp = mcpTools.map((tool) => [tool.name.replace(/^browser_/, ""), tool.inputSchema]);
    const fromHttp = http.data.tools.map((tool: any) => [tool.name, tool.input_schema]);
    expect(fromMcp).toEqual(fromHttp);
    expect(mcpTools.map((tool) => tool.name)).toContain("browser_start");
    const { stdout } = await runCli(["--help"]);
    for (const [name] of fromHttp) expect(stdout).toContain(name);
  });

  it("da el mismo resultado por CLI, HTTP y MCP", async () => {
    const fromCli = await scenario(viaCli);
    const fromHttp = await scenario(viaHttp);
    const fromMcp = await scenario(viaMcp);
    expect(fromHttp).toEqual(fromCli);
    expect(fromMcp).toEqual(fromCli);
    expect(fromCli.join("\n")).toContain("SENSITIVE_FIELD");
    expect(fromCli.join("\n")).toContain("TIMEOUT");
    expect(fromCli.join("\n")).toContain("REF_NOT_FOUND");
    expect(fromCli.join("\n")).toContain("INVALID_PARAMS");
  }, 120_000);

  it("retiene las acciones de la misma forma en las tres interfaces", async () => {
    writeFileSync(join(home, "policy.yaml"), "approval: cli\n");
    try {
      const results: string[] = [];
      for (const call of [viaCli, viaHttp, viaMcp]) {
        await call("navigate", { url: `${base}/login` });
        const page = await call("snapshot");
        results.push(normalize(await call("click", { ref: refIn(page, 'button "Entrar"') })));
      }
      expect(results[0]).toContain("CONFIRMATION_REQUIRED");
      expect(results[1]).toBe(results[0]);
      expect(results[2]).toBe(results[0]);
    } finally {
      writeFileSync(join(home, "policy.yaml"), "confirm: []\n");
    }
  }, 30_000);

  it("devuelve las capturas en el formato de cada interfaz", async () => {
    await viaHttp("navigate", { url: `${base}/login` });
    const png = (base64: string) => Buffer.from(base64, "base64").subarray(1, 4).toString();
    expect(png((await viaHttp("screenshot")).data.image.base64)).toBe("PNG");
    expect(png((await viaMcp("screenshot")).data.image.base64)).toBe("PNG");
    const out = join(home, "cli.png");
    const { stdout } = await runCli(["screenshot", "--out", out, "--json"]);
    expect(JSON.parse(stdout).data.path).toBe(out);
    expect(readFileSync(out).subarray(1, 4).toString()).toBe("PNG");
  });
});

describe("seguridad de la API HTTP", () => {
  const tool = () => `${httpUrl}/v1/tools/status`;
  const auth = () => ({ authorization: `Bearer ${token}` });

  it("crea el token con permisos 600", () => {
    expect(statSync(join(home, "token")).mode & 0o777).toBe(0o600);
  });

  it("rechaza peticiones sin token o con token incorrecto", async () => {
    expect((await fetch(tool(), { method: "POST" })).status).toBe(401);
    const wrong = await fetch(tool(), { method: "POST", headers: { authorization: "Bearer x" } });
    expect(wrong.status).toBe(401);
  });

  it("rechaza Origin aunque el token sea válido", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(tool(), { method: "POST", headers: { ...auth(), origin: "https://malo.example" } }, (res) =>
        resolve(res.statusCode!),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("rechaza un Host ajeno, como en DNS rebinding", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(tool(), { method: "POST", headers: { ...auth(), host: "malo.example" } }, (res) =>
        resolve(res.statusCode!),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("devuelve errores claros de transporte", async () => {
    expect((await fetch(`${httpUrl}/v1/tools/inexistente`, { method: "POST", headers: auth() })).status).toBe(404);
    expect((await fetch(tool(), { headers: auth() })).status).toBe(405);
    expect((await fetch(tool(), { method: "POST", headers: auth(), body: "{" })).status).toBe(400);
  });
});

describe("eventos", () => {
  it("registra consola, red fallida y diálogos, y los emite por SSE", async () => {
    const events: string[] = [];
    const abort = new AbortController();
    const stream = await fetch(`${httpUrl}/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    const reading = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
        events.push(decoder.decode(chunk));
      }
    })().catch(() => {});

    await viaCli("navigate", { url: `${base}/widgets` });
    const page = await viaCli("snapshot");
    const alerted = await viaCli("click", { ref: refIn(page, '"Abrir alerta"') });
    expect(alerted.data.dialog.kind).toBe("alert");
    await viaCli("handle_dialog", { accept: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const consoleMessages = await viaCli("console_messages", { level: "warning" });
    expect(JSON.stringify(consoleMessages.data.messages)).toContain("widgets listo");
    const failed = await viaCli("network_requests", { failed_only: true, url_contains: "no-existe" });
    expect(failed.data.requests.length).toBeGreaterThan(0);
    expect(failed.data.requests[0].data.status).toBe(404);

    abort.abort();
    await reading;
    const all = events.join("");
    expect(all).toContain("event: navigation");
    expect(all).toContain("event: console");
    expect(all).toContain("event: network");
    expect(all).toContain("Aviso de prueba");
  }, 30_000);
});

describe("tareas de punta a punta solo con el CLI", () => {
  it("completa un formulario de 3 pasos", async () => {
    await viaCli("navigate", { url: `${base}/wizard` });
    const paso1 = await viaCli("snapshot");
    await viaCli("type", { ref: refIn(paso1, '"Nombre"'), text: "Ana", submit: true });
    await viaCli("wait_for", { text: "Paso 2" });
    const paso2 = await viaCli("snapshot");
    await viaCli("select_option", { ref: refIn(paso2, '"País"'), value: "Perú" });
    await viaCli("click", { ref: refIn(paso2, '"Seguir"') });
    const paso3 = await viaCli("snapshot");
    await viaCli("click", { ref: refIn(paso3, '"Acepto"') });
    expect((await viaCli("snapshot")).data.text).toMatch(/checkbox "Acepto" \[e\d+\] checked=true/);
    await viaCli("click", { ref: refIn(paso3, '"Finalizar"') });
    expect((await viaCli("get_text")).data.text).toContain("Completado: Ana, Perú, true");
  }, 30_000);

  it("llena una historia en un formulario tipo Jira", async () => {
    await viaCli("navigate", { url: `${base}/jira` });
    const form = await viaCli("snapshot");

    await viaCli("select_option", { ref: refIn(form, '"Tipo de incidencia"'), label: "Historia" });
    await viaCli("type", { ref: refIn(form, '"Resumen"'), text: "Exportar informes a PDF" });

    const assignee = refIn(form, '"Responsable"');
    await viaCli("type", { ref: assignee, text: "ana" });
    expect((await viaCli("wait_for", { text: "Ana Quispe" })).ok).toBe(true);
    const options = await viaCli("snapshot");
    expect(options.data.text).toMatch(/option "Ana Torres" \[e\d+\]/);
    await viaCli("click", { ref: refIn(options, 'option "Ana Quispe"') });

    await viaCli("type", {
      ref: refIn(form, '"Descripción"'),
      text: "Como usuario quiero exportar mis informes a PDF",
    });
    expect((await viaCli("snapshot")).data.text).toContain('value="Ana Quispe"');

    const created = await viaCli("click", { ref: refIn(form, '"Crear"') });
    expect(created.data.url).toContain("clave=PROJ-123");
    expect((await viaCli("wait_for", { text: "PROJ-123 creada" })).ok).toBe(true);
    expect((await viaCli("get_text")).data.text).toContain(
      "PROJ-123 creada | Historia | Exportar informes a PDF | Ana Quispe | Como usuario quiero exportar mis informes a PDF",
    );
  }, 30_000);

  it("scroll lleva un elemento a la vista y desplaza la página", async () => {
    await viaCli("navigate", { url: `${base}/widgets` });
    const page = await viaCli("snapshot");
    const moved = await viaCli("scroll", { direction: "down", amount: 300 });
    expect(moved.data.y).toBeGreaterThan(0);
    const bottom = await viaCli("scroll", { ref: refIn(page, '"Al fondo"') });
    expect(bottom.data.y).toBeGreaterThan(moved.data.y);
    expect((await viaCli("scroll")).error.code).toBe("INVALID_PARAMS");
  });
});
