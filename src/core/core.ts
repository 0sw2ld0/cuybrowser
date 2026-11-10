import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { Download } from "playwright-core";
import { CuyError, toToolError, type ToolResponse } from "./errors.js";
import { downloadsDir, ensureHome, quarantineDir } from "./paths.js";
import type { AnyTool, ToolContext } from "./registry.js";
import type { Approver, Decision } from "./security/approver.js";
import { redactParams, writeAudit } from "./security/audit.js";
import { readRecentAudit } from "./security/audit-recent.js";
import { quotePageText, type Gate } from "./security/classify.js";
import { ConfirmationStore, type PendingConfirmation } from "./security/confirm.js";
import { warnInjectionInFields } from "./security/untrusted.js";
import { defaultPolicy, ensurePolicyFile, loadPolicy, type Policy } from "./security/policy.js";
import { Session, type Tab } from "./session.js";

/** Siguen disponibles aunque la política sea inválida, para poder revisarla y cerrar. */
const USABLE_WITH_INVALID_POLICY = new Set(["status", "stop", "policy_show"]);
/** No tocan la página, que queda bloqueada mientras hay un diálogo abierto. */
const USABLE_DURING_DIALOG = new Set([
  "status",
  "stop",
  "tabs_list",
  "tab_new",
  "tab_select",
  "tab_close",
  "console_messages",
  "network_requests",
  "policy_show",
  "audit_recent",
  "confirm",
  "handle_dialog",
]);

interface PendingDownload {
  confirmation_id: string;
  filename: string;
  origin: string;
  size_bytes: number | null;
  expires_at: string;
}

function safeFilename(name: string): string {
  const clean = basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_");
  return clean && clean !== "." && clean !== ".." ? clean : "descarga";
}

/** Una URL data: lleva el archivo entero dentro: nunca se copia completa al diálogo ni a la respuesta. */
export function downloadOrigin(url: string): { origin: string; source: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { origin: url.slice(0, 200), source: "un origen desconocido" };
  }
  if (parsed.protocol === "data:") {
    const header = url.slice(0, url.indexOf(",") + 1 || 40).slice(0, 80);
    return { origin: `${header}…`, source: "datos incrustados en la página (data:)" };
  }
  // blob:https://sitio/uuid pertenece al sitio que lo creó.
  if (parsed.protocol === "blob:") {
    const inner = downloadOrigin(url.slice("blob:".length));
    return { origin: url.slice(0, 200), source: inner.source };
  }
  return { origin: url.length > 200 ? `${url.slice(0, 200)}…` : url, source: parsed.host || parsed.protocol };
}

function freePath(dir: string, filename: string): string {
  const ext = extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 0; ; n++) {
    const path = join(dir, n === 0 ? filename : `${stem} (${n})${ext}`);
    try {
      statSync(path);
    } catch {
      return path;
    }
  }
}

export interface ApprovalInfo {
  mode: Policy["approval"];
  description?: string;
  decided?: boolean;
}

export class Core {
  readonly session = new Session();
  private queue: Promise<unknown> = Promise.resolve();
  private store = new ConfirmationStore();
  private newDownloads: PendingDownload[] = [];
  private downloadsInProgress = 0;
  private readonly daemonSessionId = randomUUID();
  private readonly auditCursorKey = randomBytes(32);
  private auditSeq = 0;

  constructor(
    private readonly tools: readonly AnyTool[],
    private readonly approver: Approver,
  ) {
    ensureHome();
    ensurePolicyFile();
    // Lo que quedó en cuarentena de una ejecución anterior nunca se aprobó.
    rmSync(quarantineDir(), { recursive: true, force: true });
    mkdirSync(quarantineDir(), { recursive: true, mode: 0o700 });
    this.session.onDownload = (tab, download) => void this.handleDownload(tab, download);
  }

  call(name: string, rawParams: unknown): Promise<ToolResponse> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (tool?.concurrent || this.session.handingOff) return this.execute(name, rawParams);
    return this.enqueue(() => this.execute(name, rawParams));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async shutdown(): Promise<void> {
    this.store.discardAll();
    await this.session.stop();
    rmSync(quarantineDir(), { recursive: true, force: true });
  }

  private policyFor(name: string): Policy {
    try {
      return loadPolicy();
    } catch (err) {
      if (USABLE_WITH_INVALID_POLICY.has(name)) return defaultPolicy();
      throw err;
    }
  }

  private fingerprint(gate: Gate | null, tab: Tab | null): string {
    return JSON.stringify([gate?.kinds, gate?.description, tab?.id, tab?.page.url()]);
  }

  private async execute(name: string, rawParams: unknown, approvedFingerprint?: string): Promise<ToolResponse> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    const warnings: string[] = [];
    let policy = defaultPolicy();
    let response: ToolResponse;
    let audited: unknown = rawParams;
    let auditUrl = this.currentUrl();
    let auditProfile = this.session.auditProfile;
    let auditAttached = this.session.auditAttached;
    try {
      if (!tool) throw new CuyError("INVALID_PARAMS", `Herramienta desconocida: ${name}`);
      if (this.session.handingOff && name !== "status" && name !== "stop") {
        throw new CuyError("HANDOFF_ACTIVE", "El navegador está en manos de la persona. Espera a que continúe o cancele el relevo.");
      }
      policy = this.policyFor(name);
      // Consultar el registro no aplica cambios de navegación ni toca la página.
      if (name !== "audit_recent") await this.session.applyDomainRules(policy);

      const parsed = tool.params.safeParse(rawParams ?? {});
      if (!parsed.success) throw new CuyError("INVALID_PARAMS", z.prettifyError(parsed.error));
      audited = redactParams(parsed.data, tool.auditRedact);

      const tab = this.session.running ? this.session.currentTab() : null;
      if (tab?.dialog && !USABLE_DURING_DIALOG.has(name)) {
        throw new CuyError(
          "DIALOG_OPEN",
          `La página tiene un diálogo abierto: ${quotePageText(tab.dialog.message())}`,
          "Respóndelo con handle_dialog.",
        );
      }

      const ctx: ToolContext = {
        session: this.session,
        warnings,
        policy,
        confirm: (id) => this.confirm(id, policy, warnings),
        requestHandoff: (request) => this.approver.request({ ...request, kind: "handoff" }),
        auditRecent: (params) => readRecentAudit(policy,
          { daemon_session_id: this.daemonSessionId, profile: this.session.auditProfile },
          params, this.auditCursorKey, new Set(this.tools.map((item) => item.name))),
        // Las acciones lentas conservan el perfil de entrada. Sólo un arranque
        // real puede sustituirlo por el perfil del driver que acaba de abrir.
        recordStartedProfile: (started) => {
          if (name === "start") {
            auditProfile = started.profile;
            auditAttached = started.attached;
            // Un arranque puede reemplazar el perfil anterior: no le atribuye su sitio.
            auditUrl = null;
          }
        },
      };

      const gate = tool.gate ? await tool.gate(ctx, parsed.data) : null;
      const fingerprint = this.fingerprint(gate, tab);
      if (approvedFingerprint !== undefined) {
        if (approvedFingerprint !== fingerprint) {
          throw new CuyError(
            "CONFIRMATION_DENIED",
            "La página o la acción cambió después de pedir la aprobación, así que no se ejecutó.",
            "Toma un snapshot nuevo y solicita de nuevo la acción.",
          );
        }
      } else if (gate && gate.kinds.some((kind) => policy.confirm.includes(kind))) {
        const pending = this.store.create(gate.description, () =>
          this.enqueue(() => this.execute(name, parsed.data, fingerprint)),
        );
        throw this.confirmationRequired(pending);
      }

      // El registro tampoco consume avisos de descargas ni carreras con diálogos de la página.
      const result = name === "audit_recent" ? await tool.handler(ctx, parsed.data)
        : await this.runInterruptible(tool, ctx, parsed.data, tab);
      const data = name === "audit_recent" ? result : this.attachDownloads(tool, result, warnings);
      warnInjectionInFields(data, warnings);
      response = { ok: true, data, warnings };
    } catch (err) {
      response = { ok: false, error: toToolError(err) };
    }

    // El sondeo del registro no debe producir nuevas acciones al sondearse a sí mismo.
    if (name === "audit_recent") return response;
    const seq = ++this.auditSeq;
    const auditProblem = writeAudit(policy, {
      id: `${this.daemonSessionId}:${seq}`,
      seq,
      daemon_session_id: this.daemonSessionId,
      profile: auditProfile,
      ...(auditAttached ? { attached: true as const } : {}),
      ts: new Date().toISOString(),
      tool: name,
      params: audited === rawParams ? redactParams(rawParams, tool?.auditRedact) : audited,
      url: auditUrl,
      ok: response.ok,
      ...(response.ok ? {} : { error_code: response.error.code }),
      ...(response.ok || !response.error.confirmation
        ? {}
        : { confirmation_id: response.error.confirmation.confirmation_id }),
      ...(approvedFingerprint === undefined ? {} : { approved: true }),
    });
    if (auditProblem && response.ok) response.warnings.push(auditProblem);
    return response;
  }

  private currentUrl(): string | null {
    try {
      return this.session.running ? this.session.currentTab()?.page.url() ?? null : null;
    } catch {
      return null;
    }
  }

  private confirmationRequired(pending: PendingConfirmation): CuyError {
    return new CuyError(
      "CONFIRMATION_REQUIRED",
      pending.description,
      "La acción no se ha ejecutado. Llama a confirm con este id para pedir la aprobación de la persona usuaria.",
      {
        confirmation_id: pending.id,
        description: pending.description,
        expires_at: new Date(pending.expiresAt).toISOString(),
      },
    );
  }

  /** Un diálogo bloquea la página y dejaría la herramienta esperando: se responde en cuanto aparece. */
  private async runInterruptible(tool: AnyTool, ctx: ToolContext, params: unknown, tab: Tab | null): Promise<unknown> {
    if (!tab || tool.name === "handoff") return tool.handler(ctx, params);
    let stopListening = () => {};
    const interrupted = new Promise<{ dialog: { kind: string; message: string } }>((resolve) => {
      stopListening = tab.onDialog((dialog) => {
        ctx.warnings.push("La página abrió un diálogo. Respóndelo con handle_dialog antes de seguir.");
        resolve({ dialog: { kind: dialog.type(), message: quotePageText(dialog.message()) } });
      });
    });
    const running = tool.handler(ctx, params);
    running.catch(() => {});
    try {
      return await Promise.race([running, interrupted]);
    } finally {
      stopListening();
    }
  }

  private attachDownloads(tool: AnyTool, data: unknown, warnings: string[]): unknown {
    const pending = this.newDownloads.splice(0);
    if (pending.length === 0) return data ?? {};
    const isAction = tool.risk !== "read" && typeof data === "object" && data !== null;
    const first = isAction ? pending.shift() : undefined;
    for (const download of pending) {
      warnings.push(`Descarga retenida a la espera de aprobación: ${JSON.stringify(download)}`);
    }
    return first ? { ...(data as object), pending_download: first } : data ?? {};
  }

  private async handleDownload(tab: Tab, download: Download): Promise<void> {
    const filename = safeFilename(download.suggestedFilename());
    const { origin, source } = downloadOrigin(download.url());
    const push = (data: Record<string, unknown>) =>
      this.session.events.push("download", tab.id, { filename, origin, ...data });
    let policy: Policy;
    try {
      policy = loadPolicy();
    } catch {
      await download.cancel().catch(() => {});
      push({ state: "cancelled" });
      return;
    }

    if (!policy.confirm.includes("downloads")) {
      mkdirSync(downloadsDir(), { recursive: true });
      const path = freePath(downloadsDir(), filename);
      await download.saveAs(path).catch(() => {});
      push({ state: "saved", path });
      return;
    }

    const quarantined = join(quarantineDir(), `${Date.now()}-${this.downloadsInProgress++}-${filename}`);
    const saved = download.saveAs(quarantined).then(
      () => true,
      () => false,
    );
    const discard = () => {
      void download.cancel().catch(() => {});
      void saved.then(() => rmSync(quarantined, { force: true }));
    };
    const pending = this.store.create(
      `Descargar el archivo ${quotePageText(filename)} desde ${source}.`,
      async () => {
        if (!(await saved)) {
          return { ok: false, error: { code: "INTERNAL", message: "La descarga no se completó." } };
        }
        mkdirSync(downloadsDir(), { recursive: true });
        const path = freePath(downloadsDir(), filename);
        renameSync(quarantined, path);
        return { ok: true, data: { path, size_bytes: statSync(path).size }, warnings: [] };
      },
      discard,
    );
    const info: PendingDownload = {
      confirmation_id: pending.id,
      filename,
      origin,
      size_bytes: null,
      expires_at: new Date(pending.expiresAt).toISOString(),
    };
    push({ state: "quarantined", confirmation_id: pending.id });
    this.newDownloads.push(info);
  }

  private decisionFor(pending: PendingConfirmation, policy: Policy): Promise<Decision> {
    if (policy.approval === "cli") return pending.manualDecision;
    if (policy.approval === "elicitation") {
      return pending.manuallyDecided ? pending.manualDecision : Promise.resolve("unavailable");
    }
    pending.decision ??= this.approver
      .request({
        description: pending.description,
        seconds: Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)),
        signal: pending.abort.signal,
      })
      .finally(() => {
        pending.decision = null;
      });
    return pending.decision;
  }

  private async confirm(id: string, policy: Policy, warnings: string[]): Promise<unknown> {
    const pending = this.store.require(id);
    const decision = await this.decisionFor(pending, policy);
    if (decision === "unavailable") {
      throw new CuyError(
        "APPROVAL_UNAVAILABLE",
        `No hay forma de pedir la aprobación con el canal "${policy.approval}", así que la acción no se ejecutó.`,
        "Configura otro canal en la política o usa CuyBrowser en una sesión con interfaz gráfica.",
      );
    }
    if (decision === "denied") {
      this.store.reject(pending);
      throw new CuyError("CONFIRMATION_DENIED", "La persona usuaria rechazó la acción o la solicitud expiró.");
    }
    this.store.consume(pending);
    const result = await pending.execute();
    if (!result.ok) throw new CuyError(result.error.code, result.error.message, result.error.hint);
    warnings.push(...result.warnings);
    return result.data;
  }

  approvalInfo(id: string): ApprovalInfo {
    const { approval } = this.policyFor("policy_show");
    const pending = this.store.get(id);
    return {
      mode: approval,
      ...(pending ? { description: pending.description, decided: pending.manuallyDecided } : {}),
    };
  }

  /** Respuesta humana recibida por un canal explícito. Se rechaza si no es el canal configurado. */
  resolveApproval(id: string, approved: boolean, channel: "cli" | "elicitation"): string | null {
    const { approval } = this.policyFor("policy_show");
    if (approval !== channel) return `La política usa el canal "${approval}": este comando no aprueba nada.`;
    try {
      this.store.resolveManually(id, approved);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
