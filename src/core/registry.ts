import { z } from "zod";
import type { Gate } from "./security/classify.js";
import type { Policy } from "./security/policy.js";
import type { Session } from "./session.js";

export type Risk = "read" | "action" | "sensitive";

export interface ToolContext {
  session: Session;
  warnings: string[];
  policy: Policy;
  confirm: (confirmationId: string) => Promise<unknown>;
}

/** Pistas de presentación para el CLI. No contienen lógica de la herramienta. */
export interface CliHints {
  positional?: string[];
  aliases?: Record<string, string>;
  returnsImage?: boolean;
  /** Banderas que equivalen a dar un valor concreto a un parámetro. */
  shortcuts?: Record<string, { param: string; value: unknown; description: string }>;
  format?: (data: any) => string;
}

export interface ToolDefinition<S extends z.ZodObject> {
  name: string;
  description: string;
  params: S;
  risk: Risk;
  cli?: CliHints;
  /** Parámetros que no se guardan en la auditoría. */
  auditRedact?: string[];
  /** Espera a una persona: no ocupa la cola de acciones mientras tanto. */
  concurrent?: boolean;
  /** Decide si la acción necesita aprobación. Se vuelve a evaluar justo antes de ejecutarla. */
  gate?: (ctx: ToolContext, params: z.infer<S>) => Promise<Gate | null>;
  handler: (ctx: ToolContext, params: z.infer<S>) => Promise<unknown>;
}

export interface AnyTool {
  name: string;
  description: string;
  params: z.ZodObject;
  risk: Risk;
  cli?: CliHints;
  auditRedact?: string[];
  concurrent?: boolean;
  gate?: (ctx: ToolContext, params: any) => Promise<Gate | null>;
  handler: (ctx: ToolContext, params: any) => Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): AnyTool {
  return def as unknown as AnyTool;
}
