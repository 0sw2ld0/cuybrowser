import { accessSync, constants, statSync } from "node:fs";

// Definido sólo por la compilación autónoma. La URL virtual de Bun varía por plataforma.
declare const __CUYBROWSER_AUTONOMO__: boolean;

export const isStandalone = typeof __CUYBROWSER_AUTONOMO__ !== "undefined" && __CUYBROWSER_AUTONOMO__;

export function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
