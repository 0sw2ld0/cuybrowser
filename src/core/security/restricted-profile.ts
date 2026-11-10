import { randomUUID } from "node:crypto";
import { constants, closeSync, lstatSync, openSync, readFileSync, writeFileSync, mkdirSync,
  renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Solo el perfil propio de launch: nunca restaura documentos antes de instalar la barrera CDP. */
export function prepareRestrictedProfile(directory: string): void {
  const stat = (path: string) => {
    try { return lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  if (stat(join(directory, "SingletonLock"))) throw new Error("El perfil ya tiene un bloqueo de Chromium.");
  const folder = join(directory, "Default");
  if (stat(folder)?.isSymbolicLink()) throw new Error("El directorio del perfil no puede ser un enlace.");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "Preferences");
  let preferences: Record<string, any> = {};
  const file = stat(path);
  if (file) {
    if (!file.isFile() || file.isSymbolicLink() || file.size > 16 * 1024 * 1024) {
      throw new Error("No se pueden leer con seguridad las preferencias del perfil.");
    }
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { preferences = JSON.parse(readFileSync(fd, "utf8")); } finally { closeSync(fd); }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
      throw new Error("Las preferencias del perfil no son un objeto válido.");
    }
  }
  preferences.session = { ...preferences.session, restore_on_startup: 5, startup_urls: [] };
  preferences.profile = { ...preferences.profile, exit_type: "Normal", exited_cleanly: true };
  const temporary = join(folder, `.cuybrowser-preferences-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try { writeFileSync(fd, JSON.stringify(preferences)); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
