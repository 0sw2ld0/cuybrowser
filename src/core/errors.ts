export type ErrorCode =
  | "NO_BROWSER"
  | "NO_TAB"
  | "REF_NOT_FOUND"
  | "REF_STALE"
  | "TIMEOUT"
  | "NAVIGATION_FAILED"
  | "NOT_INTERACTABLE"
  | "DIALOG_OPEN"
  | "HANDOFF_ACTIVE"
  | "BLOCKED_BY_POLICY"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_DENIED"
  | "APPROVAL_UNAVAILABLE"
  | "SENSITIVE_FIELD"
  | "AUDIT_UNAVAILABLE"
  | "AUDIT_CURSOR_EXPIRED"
  | "INVALID_PARAMS"
  | "INTERNAL";

export interface ConfirmationInfo {
  confirmation_id: string;
  description: string;
  expires_at: string;
}

export interface ToolError {
  code: ErrorCode;
  message: string;
  hint?: string;
  confirmation?: ConfirmationInfo;
}

export type ToolResponse =
  | { ok: true; data: unknown; warnings: string[] }
  | { ok: false; error: ToolError };

export class CuyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly confirmation?: ConfirmationInfo,
  ) {
    super(message);
    this.name = "CuyError";
  }
}

export function toToolError(err: unknown): ToolError {
  if (err instanceof CuyError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.confirmation ? { confirmation: err.confirmation } : {}),
    };
  }
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError") return { code: "TIMEOUT", message };
  if (/has been closed/i.test(message)) {
    return {
      code: "NO_TAB",
      message,
      hint: "Consulta las pestañas con tabs_list o inicia el navegador con start.",
    };
  }
  return { code: "INTERNAL", message };
}
