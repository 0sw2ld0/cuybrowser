import { z } from "zod";
import type { AnyTool } from "./registry.js";

export interface PropertySchema {
  type?: string;
  enum?: string[];
  description?: string;
  default?: unknown;
}

export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, PropertySchema>;
  required?: string[];
  [key: string]: unknown;
}

export function toolInputSchema(tool: AnyTool): ToolInputSchema {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.params, { io: "input" });
  return schema as ToolInputSchema;
}
