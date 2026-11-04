import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runDaemon, type DaemonHandle } from "../../src/core/daemon.js";
import type { Decision } from "../../src/core/security/approver.js";
import { callTool } from "../../src/ipc/client.js";
import { tools } from "../../src/tools/index.js";
import { startFixtureServer } from "../fixtures/server.js";

const CLI = fileURLToPath(new URL("../../dist/adapters/cli.js", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "cb-"));
process.env.CUYBROWSER_HOME = home;
const env = { ...process.env } as Record<string, string>;

const approvals: { decision: Decision; requests: string[] } = { decision: "denied", requests: [] };
let base: string;
let fixtures: Server;
let daemon: DaemonHandle;

const DEFAULT_POLICY = "approval: native-dialog\n";
const call = callTool as (tool: string, params?: unknown) => Promise<any>;

function setPolicy(yaml: string): void {
  writeFileSync(join(home, "policy.yaml"), yaml);
}

function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function refOf(label: string): Promise<string> {
  const { data } = await call("snapshot");
  const line = (data.text as string).split("\n").find((candidate) => candidate.includes(label));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`Sin ref para "${label}" en:\n${data.text}`);
  return ref;
}

async function open(page: string): Promise<void> {
  const response = await call("navigate", { url: `${base}/${page}` });
  expect(response.ok, JSON.stringify(response)).toBe(true);
}

async function pageUrl(): Promise<string> {
  const { data } = await call("tabs_list");
  return data.tabs.find((tab: { active: boolean }) => tab.active).url;
}

async function pageTitle(): Promise<string> {
  const { data } = await call("tabs_list");
  return data.tabs.find((tab: { active: boolean }) => tab.active).title;
}

function requirement(response: any): string {
  expect(response.ok, JSON.stringify(response)).toBe(false);
  expect(response.error.code).toBe("CONFIRMATION_REQUIRED");
  return response.error.confirmation.confirmation_id;
}

beforeAll(async () => {
  setPolicy(DEFAULT_POLICY);
  ({ url: base, server: fixtures } = await startFixtureServer());
  daemon = await runDaemon(tools, {
    embedded: true,
    approver: {
      request: async ({ description }) => {
        approvals.requests.push(description);
        return approvals.decision;
      },
    },
  });
  const started = await call("start", { headless: true });
  expect(started.ok, JSON.stringify(started)).toBe(true);
}, 60_000);

afterAll(async () => {
  await daemon?.close();
  fixtures?.close();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  setPolicy(DEFAULT_POLICY);
  approvals.decision = "denied";
  approvals.requests = [];
});

describe("confirmación humana", () => {
  it("retiene el envío de un formulario y lo ejecuta solo al aprobarse, una vez", async () => {
    await open("login");
    const id = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    expect(await pageUrl()).toContain("/login");

    approvals.decision = "approved";
    const confirmed = await call("confirm", { confirmation_id: id });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(confirmed.data.navigated).toBe(true);
    expect(await pageUrl()).toContain("/welcome");
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toContain("127.0.0.1");

    const again = await call("confirm", { confirmation_id: id });
    expect(again.error.code).toBe("CONFIRMATION_DENIED");
    expect(again.error.message).toContain("ya se usó");
    expect(approvals.requests).toHaveLength(1);
  });

  it("no ejecuta nada si la persona rechaza", async () => {
    await open("login");
    const id = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    const denied = await call("confirm", { confirmation_id: id });
    expect(denied.error.code).toBe("CONFIRMATION_DENIED");
    expect(await pageUrl()).toContain("/login");
    expect((await call("confirm", { confirmation_id: id })).error.code).toBe("CONFIRMATION_DENIED");
  });

  it("sin canal disponible no ejecuta nada y se puede reintentar con el mismo id", async () => {
    await open("login");
    const id = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    approvals.decision = "unavailable";
    expect((await call("confirm", { confirmation_id: id })).error.code).toBe("APPROVAL_UNAVAILABLE");
    expect(await pageUrl()).toContain("/login");
    approvals.decision = "approved";
    expect((await call("confirm", { confirmation_id: id })).ok).toBe(true);
    expect(await pageUrl()).toContain("/welcome");
  });

  it("rechaza un id inventado sin pedir nada", async () => {
    expect((await call("confirm", { confirmation_id: "inventado" })).error.code).toBe("CONFIRMATION_DENIED");
    expect(approvals.requests).toHaveLength(0);
  });

  it("no ejecuta si la página cambió después de pedir la aprobación", async () => {
    await open("login");
    const id = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    await open("reset");
    approvals.decision = "approved";
    const response = await call("confirm", { confirmation_id: id });
    expect(response.ok).toBe(false);
    expect(await pageUrl()).toContain("/reset");
  });

  it("no ejecuta si el texto del botón cambió después de pedir la aprobación", async () => {
    await open("checkout");
    const ref = await refOf('"Comprar en un clic"');
    const id = requirement(await call("click", { ref }));
    setPolicy("confirm: []\n");
    expect((await call("click", { ref })).ok).toBe(true);
    setPolicy(DEFAULT_POLICY);
    approvals.decision = "approved";
    const response = await call("confirm", { confirmation_id: id });
    expect(response.error.code).toBe("CONFIRMATION_DENIED");
    expect(response.error.message).toContain("cambió");
  });

  it("detecta compras, Enter, --submit y saltos de línea", async () => {
    await open("checkout");
    expect(await pageTitle()).toBe("Caja de la tienda");

    const buy = await call("click", { ref: await refOf('"Comprar ahora"') });
    expect(requirement(buy)).toBeTruthy();
    expect(buy.error.message).toContain("compra");
    expect(await pageTitle()).toBe("Caja de la tienda");

    const pay = await call("click", { ref: await refOf('"Pagar 20 €"') });
    expect(requirement(pay)).toBeTruthy();
    expect(pay.error.message).toContain('"Pago"');

    const address = await refOf('"Dirección"');
    requirement(await call("type", { ref: address, text: "Calle 1", submit: true }));
    requirement(await call("type", { ref: address, text: "Calle 1\n" }));
    expect((await call("type", { ref: address, text: "Calle 1" })).ok).toBe(true);
    requirement(await call("press_key", { key: "Enter" }));
    expect((await call("press_key", { key: "Tab" })).ok).toBe(true);

    expect((await call("type", { ref: await refOf('"Notas"'), text: "línea 1\nlínea 2" })).ok).toBe(true);
    expect((await call("click", { ref: await refOf('"Aplicar cupón"') })).ok).toBe(true);
    expect(await pageUrl()).toContain("/checkout");
  });

  it("el CLI solo aprueba con approval: cli", async () => {
    await open("login");
    const id = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    const refused = await cli("approve", id);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("native-dialog");
    expect(await pageUrl()).toContain("/login");

    setPolicy("approval: cli\n");
    const waiting = call("confirm", { confirmation_id: id });
    expect((await cli("approve", id)).stdout).toContain("aprobada");
    expect((await waiting).ok).toBe(true);
    expect(await pageUrl()).toContain("/welcome");

    await open("login");
    const other = requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    const rejected = call("confirm", { confirmation_id: other });
    expect((await cli("deny", other)).stdout).toContain("rechazada");
    expect((await rejected).error.code).toBe("CONFIRMATION_DENIED");
    expect(approvals.requests).toHaveLength(0);
  }, 30_000);

  it("usa elicitation por MCP y no aprueba si el cliente no la soporta", async () => {
    setPolicy("approval: elicitation\n");
    const connect = async (answer?: "accept" | "decline") => {
      const client = new Client(
        { name: "pruebas", version: "1.0.0" },
        { capabilities: answer ? { elicitation: {} } : {} },
      );
      if (answer) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: answer, content: {} }));
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env }));
      return client;
    };
    const confirmVia = async (client: Client, id: string) => {
      const result = (await client.callTool({
        name: "browser_confirm",
        arguments: { confirmation_id: id },
      })) as { content: { text: string }[] };
      return JSON.parse(result.content[0]!.text);
    };
    const pendingId = async () => {
      await open("login");
      return requirement(await call("click", { ref: await refOf('button "Entrar"') }));
    };

    const plain = await connect();
    expect((await confirmVia(plain, await pendingId())).error.code).toBe("APPROVAL_UNAVAILABLE");
    await plain.close();

    const declining = await connect("decline");
    expect((await confirmVia(declining, await pendingId())).error.code).toBe("CONFIRMATION_DENIED");
    await declining.close();

    const accepting = await connect("accept");
    expect((await confirmVia(accepting, await pendingId())).ok).toBe(true);
    await accepting.close();
    expect(await pageUrl()).toContain("/welcome");
    expect(approvals.requests).toHaveLength(0);
  }, 30_000);
});

describe("política de dominios", () => {
  it("bloquea por deny, redirecciones y enlaces, y se aplica sin reiniciar", async () => {
    setPolicy("confirm: []\ndomains:\n  deny: [localhost]\n");
    await open("checkout");
    expect((await call("navigate", { url: "http://localhost:1/" })).error.code).toBe("BLOCKED_BY_POLICY");
    expect((await call("tab_new", { url: "http://localhost:1/" })).error.code).toBe("BLOCKED_BY_POLICY");
    expect((await call("navigate", { url: `${base}/redirigir` })).error.code).toBe("BLOCKED_BY_POLICY");

    await open("checkout");
    const redirected = await call("click", { ref: await refOf('"Redirección prohibida"') });
    expect(redirected.warnings.join(" ")).toContain("se canceló");
    expect(await pageUrl()).not.toContain("localhost");

    await open("checkout");
    const link = await call("click", { ref: await refOf('"Sitio externo"') });
    expect(link.ok).toBe(true);
    expect(link.data.navigated).toBe(false);
    expect(link.warnings.join(" ")).toContain("bloqueó");
    expect(await pageUrl()).toContain("/checkout");

    setPolicy("confirm: []\n");
    const free = await call("navigate", { url: "http://localhost:1/" });
    expect(free.error.code).toBe("NAVIGATION_FAILED");
  }, 60_000);

  it("con allow, solo se abre lo permitido", async () => {
    setPolicy("domains:\n  allow: ['127.0.0.1']\n");
    await open("login");
    expect((await call("navigate", { url: "https://example.com/" })).error.code).toBe("BLOCKED_BY_POLICY");
  });

  it("una política inválida bloquea las acciones sin ignorarse", async () => {
    setPolicy("confirm: [algo_raro]\n");
    const blocked = await call("navigate", { url: `${base}/login` });
    expect(blocked.error.code).toBe("BLOCKED_BY_POLICY");
    expect((await call("snapshot")).error.code).toBe("BLOCKED_BY_POLICY");
    expect((await call("status")).ok).toBe(true);
    const shown = await call("policy_show");
    expect(shown.data.valid).toBe(false);
  });
});

describe("campos sensibles", () => {
  it("bloquea contraseñas y tarjetas, y respeta la política", async () => {
    await open("login");
    const password = await refOf('"Contraseña"');
    expect((await call("type", { ref: password, text: "clave-super-secreta" })).error.code).toBe("SENSITIVE_FIELD");
    await open("checkout");
    expect((await call("type", { ref: await refOf('"Número de tarjeta"'), text: "4111" })).error.code).toBe(
      "SENSITIVE_FIELD",
    );

    setPolicy("sensitive_fields:\n  block_typing: false\n");
    await open("login");
    expect((await call("type", { ref: await refOf('"Contraseña"'), text: "clave-permitida" })).ok).toBe(true);
    expect((await call("snapshot")).data.text).not.toContain("clave-permitida");
  });
});

describe("contenido no confiable", () => {
  it("delimita el contenido y avisa de injection visible sin bloquear", async () => {
    await open("injection");
    const snapshot = await call("snapshot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.data.text.startsWith("<<<PAGE_CONTENT\n")).toBe(true);
    expect(snapshot.data.text.endsWith("\nPAGE_CONTENT>>>")).toBe(true);
    expect(snapshot.data.text.match(/PAGE_CONTENT>>>/g)).toHaveLength(1);
    expect(snapshot.warnings.join(" ")).toContain("prompt injection");

    const text = await call("get_text");
    expect(text.data.text.match(/<<<PAGE_CONTENT/g)).toHaveLength(1);
    expect(text.warnings.join(" ")).toContain("prompt injection");
  });

  it("avisa de injection en texto oculto con CSS", async () => {
    await open("hidden");
    const snapshot = await call("snapshot");
    expect(snapshot.warnings.join(" ")).toContain("oculto");
  });

  it("no avisa en una página normal", async () => {
    await open("login");
    expect((await call("snapshot")).warnings).toEqual([]);
  });
});

describe("auditoría", () => {
  it("registra las acciones sin guardar lo que se escribe, con permisos 600", async () => {
    await open("login");
    await call("type", { ref: await refOf('"Correo"'), text: "persona@correo.com" });
    await call("type", { ref: await refOf('"Contraseña"'), text: "clave-super-secreta" });
    const path = join(home, "audit.jsonl");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("persona@correo.com");
    expect(raw).not.toContain("clave-super-secreta");
    const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
    const blocked = entries.findLast((entry) => entry.error_code === "SENSITIVE_FIELD");
    expect(blocked.tool).toBe("type");
    expect(blocked.url).toContain("/login");
    expect(blocked.params.text).toBe("[oculto, 19 caracteres]");
    expect(typeof blocked.ts).toBe("string");

    await call("click", { ref: await refOf('button "Entrar"') });
    const after = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(after.at(-1).error_code).toBe("CONFIRMATION_REQUIRED");
    expect(after.at(-1).confirmation_id).toBeTruthy();
  });

  it("se puede desactivar", async () => {
    setPolicy("audit:\n  enabled: false\n");
    const path = join(home, "audit.jsonl");
    const before = readFileSync(path, "utf8");
    await call("status");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("descargas", () => {
  const startDownload = async () => {
    await open("checkout");
    const clicked = await call("click", { ref: await refOf('"Descargar informe"') });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    let info = clicked.data.pending_download;
    for (let i = 0; !info && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = await call("status");
      const warning = next.warnings.find((text: string) => text.includes("Descarga retenida"));
      if (warning) info = JSON.parse(warning.slice(warning.indexOf("{")));
    }
    expect(info).toBeTruthy();
    expect(info.filename).toBe("informe.txt");
    return info;
  };
  const quarantine = () => readdirSync(join(home, "quarantine"));
  const downloads = join(home, "downloads");
  const waitEmpty = async () => {
    for (let i = 0; quarantine().length > 0 && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it("retiene el archivo y lo entrega al aprobarse", async () => {
    rmSync(downloads, { recursive: true, force: true });
    const info = await startDownload();
    expect(existsSync(join(downloads, "informe.txt"))).toBe(false);

    approvals.decision = "approved";
    const confirmed = await call("confirm", { confirmation_id: info.confirmation_id });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(readFileSync(confirmed.data.path, "utf8")).toBe("contenido de prueba");
    expect(confirmed.data.path).toBe(join(downloads, "informe.txt"));
    expect(quarantine()).toEqual([]);
  });

  it("borra el archivo si se rechaza", async () => {
    rmSync(downloads, { recursive: true, force: true });
    const info = await startDownload();
    const denied = await call("confirm", { confirmation_id: info.confirmation_id });
    expect(denied.error.code).toBe("CONFIRMATION_DENIED");
    await waitEmpty();
    expect(quarantine()).toEqual([]);
    expect(existsSync(downloads)).toBe(false);
  });

  it("guarda directamente si la política no pide aprobación", async () => {
    rmSync(downloads, { recursive: true, force: true });
    setPolicy("confirm: []\n");
    await open("checkout");
    await call("click", { ref: await refOf('"Descargar informe"') });
    for (let i = 0; !existsSync(join(downloads, "informe.txt")) && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(readFileSync(join(downloads, "informe.txt"), "utf8")).toBe("contenido de prueba");
  });
});

describe("subida de archivos", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cb-subir-")), "subir.txt");

  it("pide aprobación, adjunta y rechaza rutas no válidas o protegidas", async () => {
    writeFileSync(file, "hola");
    await open("checkout");
    const ref = await refOf('"Adjunto"');
    expect((await call("upload_file", { ref, paths: ["/no/existe.txt"] })).error.code).toBe("INVALID_PARAMS");
    expect((await call("upload_file", { ref, paths: [join(home, "token")] })).error.code).toBe("BLOCKED_BY_POLICY");

    const id = requirement(await call("upload_file", { ref, paths: [file] }));
    expect(await pageTitle()).toBe("Caja de la tienda");
    approvals.decision = "approved";
    const confirmed = await call("confirm", { confirmation_id: id });
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    expect(await pageTitle()).toBe("Adjunto: subir.txt");
  });

  it("rechaza un elemento que no es de archivo", async () => {
    setPolicy("confirm: []\n");
    writeFileSync(file, "hola");
    await open("checkout");
    const response = await call("upload_file", { ref: await refOf('"Dirección"'), paths: [file] });
    expect(response.error.code).toBe("NOT_INTERACTABLE");
  });
});

describe("evaluate", () => {
  it("está deshabilitada por defecto y requiere aprobación al habilitarla", async () => {
    await open("login");
    expect((await call("evaluate", { expression: "1 + 1" })).error.code).toBe("BLOCKED_BY_POLICY");
    expect(approvals.requests).toHaveLength(0);

    setPolicy("evaluate:\n  enabled: true\n");
    const id = requirement(await call("evaluate", { expression: "1 + 1" }));
    approvals.decision = "approved";
    expect((await call("confirm", { confirmation_id: id })).data.value).toBe(2);
    expect(approvals.requests[0]).toContain("1 + 1");
  });
});

describe("diálogos", () => {
  const output = async () => (await call("get_text")).data.text as string;

  it("avisa, bloquea otras herramientas hasta responder y aplica la respuesta", async () => {
    await open("dialogs");
    const ask = await call("click", { ref: await refOf('"Preguntar"') });
    expect(ask.ok).toBe(true);
    expect(ask.data.dialog.kind).toBe("confirm");
    expect(ask.data.dialog.message).toContain("Continuar");

    expect((await call("snapshot")).error.code).toBe("DIALOG_OPEN");
    expect((await call("tabs_list")).ok).toBe(true);
    expect((await call("handle_dialog", { accept: true })).ok).toBe(true);
    expect(await output()).toContain("confirm: true");
    expect((await call("handle_dialog", { accept: true })).error.code).toBe("INVALID_PARAMS");

    await call("click", { ref: await refOf('"Preguntar"') });
    await call("handle_dialog", { accept: false });
    expect(await output()).toContain("confirm: false");
  });

  it("pasa el texto de un prompt y no lo guarda en la auditoría", async () => {
    await open("dialogs");
    await call("click", { ref: await refOf('"Pedir nombre"') });
    await call("handle_dialog", { accept: true, prompt_text: "Nombre-Muy-Privado" });
    expect(await output()).toContain("prompt: Nombre-Muy-Privado");
    expect(readFileSync(join(home, "audit.jsonl"), "utf8")).not.toContain("Nombre-Muy-Privado");
  });

  it("pide aprobación para aceptar un diálogo que parece una compra", async () => {
    await open("dialogs");
    const opened = await call("click", { ref: await refOf('"Doble paso"') });
    expect(opened.data?.dialog?.kind, JSON.stringify(opened)).toBe("confirm");
    const id = requirement(await call("handle_dialog", { accept: true }));
    approvals.decision = "approved";
    expect((await call("confirm", { confirmation_id: id })).ok).toBe(true);
    expect(await output()).toContain("pago: true");
  });
});
