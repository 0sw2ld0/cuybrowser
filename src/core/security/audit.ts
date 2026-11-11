import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { auditPath, type Policy } from "./policy.js";

export interface AuditEntry {
  id: string;
  seq: number;
  daemon_session_id: string;
  profile: string | null;
  attached?: true;
  ts: string;
  tool: string;
  params: unknown;
  url: string | null;
  ok: boolean;
  error_code?: string;
  confirmation_id?: string;
  approved?: boolean;
}

/** Sustituye los valores indicados por su longitud para no guardar lo que se escribe. */
export function redactParams(params: unknown, fields: readonly string[] = []): unknown {
  if (typeof params !== "object" || params === null) return params;
  const copy: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  for (const field of fields) {
    const value = copy[field];
    if (typeof value === "string") copy[field] = `[oculto, ${value.length} caracteres]`;
  }
  return copy;
}

export function writeAudit(policy: Policy, entry: AuditEntry): string | null {
  if (!policy.audit.enabled) return null;
  try {
    const path = auditPath(policy);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return null;
  } catch (err) {
    return `No se pudo escribir la auditoría: ${err instanceof Error ? err.message : String(err)}`;
  }
}
