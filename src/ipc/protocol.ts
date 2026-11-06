import type { ApprovalInfo } from "../core/core.js";
import type { ToolResponse } from "../core/errors.js";
import type { BrowserEvent } from "../core/events.js";

export type IpcRequest =
  | { id: number; type: "tool"; tool: string; params: unknown }
  | { id: number; type: "ping" }
  | { id: number; type: "shutdown" }
  | { id: number; type: "subscribe" }
  | { id: number; type: "approval_info"; confirmation_id: string }
  | {
      id: number;
      type: "resolve_approval";
      confirmation_id: string;
      approved: boolean;
      channel: "cli" | "elicitation";
    };

export type IpcReply =
  | { id: number; type: "tool"; response: ToolResponse }
  /** Los daemons compilados antes de esta comprobación no envían version. */
  | { id: number; type: "pong"; pid: number; version?: string }
  | { id: number; type: "bye" }
  | { id: number; type: "event"; event: BrowserEvent }
  | { id: number; type: "approval_info"; info: ApprovalInfo }
  | { id: number; type: "resolved"; error: string | null };

/** Convierte un flujo de texto en mensajes JSON separados por saltos de línea. */
export function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) onLine(line);
    }
  };
}
