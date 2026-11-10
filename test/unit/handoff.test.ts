import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Core } from "../../src/core/core.js";
import { dialogCommands, type ApprovalRequest, type Decision } from "../../src/core/security/approver.js";
import handoff from "../../src/tools/handoff.js";
import { tools } from "../../src/tools/index.js";

let home: string;
let core: Core;
let resume: (decision: Decision) => void;
let requested: Promise<ApprovalRequest>;
let url: string;
const page = {
  bringToFront: vi.fn(async () => {}),
  url: () => url,
  title: async () => "Sesión iniciada",
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cb-handoff-"));
  vi.stubEnv("CUYBROWSER_HOME", home);
  url = "https://ejemplo.test/login?token=no-mostrar";
  let notify: (request: ApprovalRequest) => void;
  requested = new Promise((resolve) => { notify = resolve; });
  core = new Core(tools, { request: async (request) => {
    notify(request);
    return new Promise((resolve) => { resume = resolve; });
  } });
  const tab = { id: "t1", page, onDialog: () => () => {} } as any;
  vi.spyOn(core.session, "activeTab").mockReturnValue(tab);
  vi.spyOn(core.session, "currentTab").mockReturnValue(tab);
  vi.spyOn(core.session, "running", "get").mockReturnValue(true);
  // La prueba aísla la coordinación del navegador: la ventana real se verifica en la demo.
  vi.spyOn(core.session as any, "requireContext").mockReturnValue({});
});

afterEach(async () => {
  await core.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("relevo", () => {
  it("espera la intervención, bloquea acciones y devuelve la URL y el título nuevos", async () => {
    const pending = core.call("handoff", { reason: "Entra en tu cuenta" });
    const request = await requested;
    expect(request.kind).toBe("handoff");
    expect(request.description).toContain("https://ejemplo.test");
    expect(request.description).not.toContain("no-mostrar");
    expect(core.session.handingOff).toBe(true);
    for (const tool of ["click", "navigate", "snapshot", "confirm", "handoff"]) {
      const result: any = await core.call(tool, {});
      expect(result.error.code).toBe("HANDOFF_ACTIVE");
    }
    url = "https://ejemplo.test/cuenta";
    resume("approved");
    const result: any = await pending;
    expect(result.ok).toBe(true);
    expect(result.data.url).toBe(url);
    expect(result.data.title).toBe("Sesión iniciada");
    expect(result.data.note).toContain("datos");
    expect(page.bringToFront).toHaveBeenCalled();
    expect(core.session.handingOff).toBe(false);
  });

  it.each(["denied", "unavailable"] as const)("libera el relevo si el diálogo devuelve %s", async (decision) => {
    const pending = core.call("handoff", { reason: "Completa el captcha" });
    await requested;
    resume(decision);
    const result: any = await pending;
    expect(result.error.code).toBe(decision === "denied" ? "CONFIRMATION_DENIED" : "APPROVAL_UNAVAILABLE");
    expect(core.session.handingOff).toBe(false);
  });

  it("stop cancela la espera sin esperar al diálogo", async () => {
    const pending = core.call("handoff", { reason: "Inicia sesión" });
    const request = await requested;
    expect((await core.call("stop", {})).ok).toBe(true);
    expect(request.signal.aborted).toBe(true);
    expect((await pending as any).error.code).toBe("CONFIRMATION_DENIED");
  });

  it("el plazo cancela incluso si un aprobador no responde", async () => {
    vi.useFakeTimers();
    const pending = core.call("handoff", { reason: "Inicia sesión" });
    const request = await requested;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(request.signal.aborted).toBe(true);
    expect((await pending as any).error.code).toBe("CONFIRMATION_DENIED");
    expect(core.session.handingOff).toBe(false);
  });

  it("rechaza headless antes de abrir un diálogo", async () => {
    (core.session as any).headless = true;
    expect((await core.call("handoff", { reason: "Inicia sesión" }) as any).error.code).toBe("INVALID_PARAMS");
    expect(core.session.handingOff).toBe(false);
  });

  it("valida un motivo no vacío y sin campos inesperados", () => {
    expect(handoff.params.safeParse({ reason: " " }).success).toBe(false);
    expect(handoff.params.safeParse({ reason: "x", approved: true }).success).toBe(false);
  });
});

it("el diálogo de relevo tiene Continuar/Cancelar y nunca interpola texto de página en código", () => {
  const hostile = '"; do shell script "evil"';
  const mac = dialogCommands("darwin", hostile, 120, {}, "handoff")[0]!;
  expect(mac.args).toContain(hostile);
  expect(mac.args.filter((_, i) => mac.args[i - 1] === "-e").join(" ")).not.toContain(hostile);
  expect(mac.interpret(0, "Continuar|false")).toBe("approved");
  expect(mac.interpret(0, "Continuar|true")).toBe("denied");
  expect(mac.interpret(0, "Cancelar|false")).toBe("denied");
  const windows = dialogCommands("win32", hostile, 120, {}, "handoff")[0]!;
  expect(windows.env?.CUYBROWSER_DIALOG_TEXT).toBe(hostile);
  expect(windows.args.join(" ")).toContain("Continuar");
  expect(windows.args.join(" ")).not.toContain(hostile);
  const linux = dialogCommands("linux", hostile, 120, { DISPLAY: ":0" }, "handoff");
  expect(linux[0]!.args).toContain("--ok-label=Continuar");
  expect(linux[1]!.args).toContain("Cancelar");
});
