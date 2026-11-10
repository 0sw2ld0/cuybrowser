import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CuyError } from "../errors.js";
import { homeDir } from "../paths.js";

export const CONFIRM_KINDS = ["submit_forms", "purchases", "file_upload", "downloads", "evaluate"] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];

const Origin = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.port === "0") throw new Error("origin");
    return url.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "Indica un origen http(s), sin ruta, credenciales ni parámetros." });
    return z.NEVER;
  }
});

const PolicySchema = z.strictObject({
  domains: z
    .strictObject({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .prefault({}),
  // Ausente conserva la política anterior; presente con allow vacío no autoriza ningún origen.
  origins: z.strictObject({ allow: z.array(Origin).default([]), deny: z.array(Origin).default([]),
    visit: z.strictObject({ id: z.string().min(1).max(100), origin: Origin }).optional() }).optional(),
  local_network: z.strictObject({ allow_origins: z.array(Origin).default([]) }).optional(),
  approval: z.enum(["native-dialog", "elicitation", "cli"]).default("native-dialog"),
  confirm: z.array(z.enum(CONFIRM_KINDS)).default([...CONFIRM_KINDS]),
  sensitive_fields: z.strictObject({ block_typing: z.boolean().default(true) }).prefault({}),
  evaluate: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
  attach: z.strictObject({ enabled: z.boolean().default(false) }).prefault({}),
  audit: z
    .strictObject({
      enabled: z.boolean().default(true),
      path: z.string().optional(),
    })
    .prefault({}),
});

export type Policy = z.infer<typeof PolicySchema>;

const TEMPLATE = `# Política de CuyBrowser. Los cambios se aplican en la siguiente acción.
domains:
  allow: []            # vacío = todos permitidos excepto los de deny
  deny: []             # "*.banco.com" incluye banco.com y sus subdominios
approval: native-dialog   # native-dialog | elicitation | cli
confirm:               # acciones que requieren aprobación humana
  - submit_forms
  - purchases
  - file_upload
  - downloads
  - evaluate
sensitive_fields:
  block_typing: true
evaluate:
  enabled: false
attach:                # conectarse a un Chrome abierto con --remote-debugging-port
  enabled: false       # el agente vería todas sus pestañas y sesiones
audit:
  enabled: true
`;

export function policyPath(): string {
  return join(homeDir(), "policy.yaml");
}

export function ensurePolicyFile(): void {
  try {
    writeFileSync(policyPath(), TEMPLATE, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function defaultPolicy(): Policy {
  return PolicySchema.parse({});
}

/** Una política inválida nunca se ignora: quien llama debe bloquear las acciones. */
export function loadPolicy(): Policy {
  let raw: string;
  try {
    raw = readFileSync(policyPath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultPolicy();
    throw err;
  }
  try {
    return PolicySchema.parse(parse(raw) ?? {});
  } catch (err) {
    const detail = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
    throw new CuyError("BLOCKED_BY_POLICY", `La política no es válida: ${detail}`, `Corrige ${policyPath()}.`);
  }
}

export function auditPath(policy: Policy): string {
  const path = policy.audit.path;
  if (!path) return join(homeDir(), "audit.jsonl");
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function matches(host: string, pattern: string): boolean {
  const rule = pattern.trim().toLowerCase();
  if (rule.startsWith("*.")) {
    let domain: string;
    try {
      domain = new URL(`http://${rule.slice(2)}`).hostname;
    } catch {
      return false;
    }
    return host === domain || host.endsWith(`.${domain}`);
  }
  try {
    return host === new URL(`http://${rule}`).hostname;
  } catch {
    return host === rule;
  }
}

export function hasDomainRules(policy: Policy): boolean {
  return policy.origins !== undefined || policy.local_network !== undefined
    || policy.domains.allow.length > 0 || policy.domains.deny.length > 0;
}

export function isUrlAllowed(policy: Policy, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  if (policy.origins && (policy.origins.deny.includes(parsed.origin)
    || (!policy.origins.allow.includes(parsed.origin) && policy.origins.visit?.origin !== parsed.origin))) return false;
  const host = parsed.hostname.toLowerCase();
  if (policy.domains.deny.some((rule) => matches(host, rule))) return false;
  return policy.domains.allow.length === 0 || policy.domains.allow.some((rule) => matches(host, rule));
}

export function assertUrlAllowed(policy: Policy, url: string): void {
  if (!isUrlAllowed(policy, url)) {
    throw new CuyError("BLOCKED_BY_POLICY", `La política no permite abrir ${url}.`, `Revísala en ${policyPath()}.`);
  }
}
