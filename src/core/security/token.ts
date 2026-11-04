import { randomBytes } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "../paths.js";

export function tokenPath(): string {
  return join(homeDir(), "token");
}

/** Crea el token si no existe. La bandera wx evita pisarlo si dos procesos arrancan a la vez. */
export function ensureToken(): void {
  try {
    writeFileSync(tokenPath(), randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

export function readToken(): string {
  const path = tokenPath();
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`Permisos demasiado abiertos en ${path}. Ejecuta: chmod 600 ${path}`);
  }
  return readFileSync(path, "utf8").trim();
}
