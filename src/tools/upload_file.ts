import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { homeDir } from "../core/paths.js";
import { defineTool } from "../core/registry.js";
import { pageHost, quotePageText } from "../core/security/classify.js";

/** Credenciales, claves y perfiles de navegador. Cada entrada bloquea esa ruta y todo lo que contenga. */
const PROTECTED = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gcloud",
  ".config/gh",
  ".config/google-chrome",
  ".config/chromium",
  ".config/microsoft-edge",
  ".config/BraveSoftware",
  ".local/share/keyrings",
  ".password-store",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "Library/Keychains",
  "Library/Cookies",
  // Perfiles personales de los navegadores que CuyBrowser puede abrir: guardan cookies y contraseñas.
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Chromium",
  "Library/Application Support/Arc",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
  "AppData/Local/BraveSoftware/Brave-Browser/User Data",
  "AppData/Local/Chromium/User Data",
];

/**
 * La versión nativa devuelve la ruta canónica. La de JavaScript conserva las mayúsculas y los nombres cortos
 * de Windows (RUNNER~1) que se le pasen, así que ~/.SSH en macOS o un nombre 8.3 esquivarían el bloqueo.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** En macOS y Windows el sistema de archivos no suele distinguir mayúsculas: comparar sin ellas solo bloquea de más. */
const comparable =
  process.platform === "darwin" || process.platform === "win32"
    ? (path: string) => path.toLowerCase()
    : (path: string) => path;

function isInside(path: string, dir: string): boolean {
  const target = comparable(path);
  const base = comparable(dir);
  return target === base || target.startsWith(`${base}${sep}`);
}

function protectedDirs(): string[] {
  const home = homedir();
  return [homeDir(), ...PROTECTED.map((dir) => join(home, dir))].map(canonical);
}

/** La persona tiene que ver qué archivo aprueba: si no cabe, se recorta por el principio y se conserva el nombre. */
function displayPath(path: string): string {
  const home = canonical(homedir());
  const relative = isInside(path, home) ? `~${path.slice(home.length)}` : path;
  // JSON duplicaría las barras invertidas de Windows en el diálogo: se muestran como /.
  const shown = sep === "\\" ? relative.replaceAll("\\", "/") : relative;
  return shown.length > 80 ? `…${shown.slice(-79)}` : shown;
}

/** Se resuelven los enlaces simbólicos para que uno no pueda apuntar a una carpeta protegida. */
function checkPaths(paths: string[]): string[] {
  const blocked = protectedDirs();
  return paths.map((path) => {
    let real: string;
    try {
      real = realpathSync.native(resolve(path));
      if (!statSync(real).isFile()) throw new Error("not_file");
    } catch {
      throw new CuyError("INVALID_PARAMS", `El archivo no existe o no es un archivo: ${path}`);
    }
    if (blocked.some((dir) => isInside(real, dir))) {
      throw new CuyError("BLOCKED_BY_POLICY", `No se permite subir archivos de esa carpeta: ${path}`);
    }
    return real;
  });
}

export default defineTool({
  name: "upload_file",
  description: "Adjunta archivos locales a un campo de tipo archivo.",
  params: z.strictObject({
    ref: z.string().describe("Ref del campo de archivo."),
    paths: z.array(z.string()).min(1).describe("Rutas de los archivos, separadas por comas en el CLI."),
  }),
  risk: "sensitive",
  cli: { positional: ["ref"] },
  gate: async ({ session }, { paths }) => {
    const names = checkPaths(paths).map((path) => quotePageText(displayPath(path)));
    return {
      kinds: ["file_upload"],
      description: `Subir ${names.join(", ")} a ${pageHost(session.activeTab())}.`,
    };
  },
  handler: async ({ session }, { ref, paths }) => {
    const files = checkPaths(paths);
    const tab = session.activeTab();
    const element = await resolveElement(tab, ref);
    try {
      const isFileInput = await element.call<boolean>(
        "function(){return this.tagName==='INPUT'&&this.type==='file'&&!this.disabled}",
      );
      if (!isFileInput) throw element.notInteractable("no es un campo de archivo");
      const cdp = await tab.cdp();
      await cdp.send("DOM.setFileInputFiles", { files, backendNodeId: element.backendNodeId });
      await element.call("function(){this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}");
      return { uploaded: files.length };
    } finally {
      await element.dispose();
    }
  },
});
