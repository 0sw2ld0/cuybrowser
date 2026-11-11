import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { CuyError } from "../errors.js";
import { homeDir } from "../paths.js";
import { isExecutable } from "../runtime.js";

/** Navegadores que se buscan, en este orden, cuando nadie elige uno. */
export const BROWSER_IDS = ["chrome", "msedge", "brave", "chromium", "arc"] as const;
export type BrowserId = (typeof BROWSER_IDS)[number];

export const BROWSER_NAMES: Record<BrowserId, string> = {
  chrome: "Google Chrome",
  msedge: "Microsoft Edge",
  brave: "Brave",
  chromium: "Chromium",
  arc: "Arc",
};

export const PLAYWRIGHT_CHROMIUM_NAME = "Chromium de Playwright";
/** Medido con Chrome for Testing 156 en macOS arm64. */
export const PLAYWRIGHT_CHROMIUM_SIZE = "unos 190 MB de descarga y 370 MB en disco";

export interface BrowserCandidate {
  /** Lo que se escribe en --browser; "custom" si se dio una ruta. */
  id: BrowserId | "custom";
  name: string;
  executablePath: string;
  /** Cada navegador guarda su perfil aparte: un perfil abierto por otra versión de Chromium puede estropearse. */
  profileKey: string;
}

/** Lo que la elección necesita del sistema; las pruebas lo sustituyen por uno simulado. */
export interface BrowserSystem {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** Existe y se puede ejecutar. */
  isExecutable(path: string): boolean;
  /** Donde estaría el Chromium que descarga install-browser, esté o no. */
  playwrightChromium: string | null;
}

/** Rutas habituales de cada navegador, en el orden en que se prueban. */
export function knownPaths(id: BrowserId, system: Pick<BrowserSystem, "platform" | "env" | "home">): string[] {
  const { platform, env, home } = system;
  if (platform === "darwin") {
    const app = {
      chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
      msedge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
      chromium: "Chromium.app/Contents/MacOS/Chromium",
      arc: "Arc.app/Contents/MacOS/Arc",
    }[id];
    return [posix.join("/Applications", app), posix.join(home, "Applications", app)];
  }
  if (platform === "linux") {
    return {
      chrome: ["/opt/google/chrome/chrome"],
      msedge: ["/opt/microsoft/msedge/msedge"],
      brave: ["/opt/brave.com/brave/brave"],
      // El Chromium de snap no puede leer ~/.cuybrowser; si es el único, fallará al abrirlo y se probará el siguiente.
      chromium: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/lib/chromium/chromium"],
      arc: [],
    }[id];
  }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]].filter(
      (root): root is string => Boolean(root),
    );
    const relative = {
      chrome: ["Google\\Chrome\\Application\\chrome.exe"],
      msedge: ["Microsoft\\Edge\\Application\\msedge.exe"],
      brave: ["BraveSoftware\\Brave-Browser\\Application\\brave.exe"],
      chromium: ["Chromium\\Application\\chrome.exe"],
      // Arc para Windows se instala como paquete de la tienda y no admite un perfil aparte.
      arc: [],
    }[id];
    return roots.flatMap((root) => relative.map((path) => `${root.replace(/[\\/]+$/, "")}\\${path}`));
  }
  return [];
}

function candidate(id: BrowserId, executablePath: string): BrowserCandidate {
  return { id, name: BROWSER_NAMES[id], executablePath, profileKey: id };
}

function playwrightCandidate(executablePath: string): BrowserCandidate {
  return { id: "chromium", name: PLAYWRIGHT_CHROMIUM_NAME, executablePath, profileKey: "playwright" };
}

function installed(id: BrowserId, system: BrowserSystem): BrowserCandidate[] {
  const found = knownPaths(id, system).find((path) => system.isExecutable(path));
  const list = found ? [candidate(id, found)] : [];
  // El Chromium descargado va detrás de los instalados: es el último recurso.
  if (id === "chromium" && system.playwrightChromium && system.isExecutable(system.playwrightChromium)) {
    list.push(playwrightCandidate(system.playwrightChromium));
  }
  return list;
}

/** Todos los navegadores instalados, en el orden en que se prueban. */
export function detectBrowsers(system: BrowserSystem): BrowserCandidate[] {
  const list = BROWSER_IDS.flatMap((id) => installed(id, system));
  // El Chromium de Playwright, al final de todo aunque su grupo sea chromium.
  return [...list.filter((item) => item.profileKey !== "playwright"), ...list.filter((item) => item.profileKey === "playwright")];
}

function isBrowserId(value: string): value is BrowserId {
  return (BROWSER_IDS as readonly string[]).includes(value);
}

/** En macOS se admite también la carpeta .app: el ejecutable suele llevar su mismo nombre. */
function customPath(path: string, system: BrowserSystem): string {
  if (system.isExecutable(path)) return path;
  if (system.platform === "darwin" && /\.app\/?$/.test(path)) {
    const bundle = path.replace(/\/$/, "");
    const inside = posix.join(bundle, "Contents", "MacOS", posix.basename(bundle, ".app"));
    if (system.isExecutable(inside)) return inside;
  }
  throw new CuyError(
    "NO_BROWSER",
    `No hay ningún ejecutable en ${path}.`,
    system.platform === "darwin"
      ? "Indica el programa de dentro de la aplicación, por ejemplo /Applications/Vivaldi.app/Contents/MacOS/Vivaldi."
      : "Indica la ruta completa del ejecutable del navegador.",
  );
}

function noBrowserHint(install = "uno de ellos"): string {
  return `Instala ${install} o ejecuta \`cuybrowser install-browser\` para descargar una sola vez el ${PLAYWRIGHT_CHROMIUM_NAME} (${PLAYWRIGHT_CHROMIUM_SIZE}). CuyBrowser nunca lo descarga por su cuenta.`;
}

export function noBrowserError(): CuyError {
  const names = BROWSER_IDS.map((id) => BROWSER_NAMES[id]);
  return new CuyError(
    "NO_BROWSER",
    `No se encontró ningún navegador compatible: ${names.slice(0, -1).join(", ")} o ${names.at(-1)}.`,
    noBrowserHint(),
  );
}

/**
 * Navegadores que se intentarán abrir, en orden. Con choice se usa solo ese: un id de BROWSER_IDS
 * o la ruta absoluta de un ejecutable. Sin choice, todos los instalados.
 */
export function resolveBrowsers(choice: string | undefined, system: BrowserSystem): BrowserCandidate[] {
  const wanted = choice?.trim();
  if (!wanted || wanted === "auto") {
    const list = detectBrowsers(system);
    if (list.length === 0) throw noBrowserError();
    return list;
  }
  const id = wanted.toLowerCase();
  if (isBrowserId(id)) {
    const list = installed(id, system);
    if (list.length > 0) return list;
    throw new CuyError(
      "NO_BROWSER",
      `${BROWSER_NAMES[id]} no está instalado en este equipo, o no en las rutas habituales.`,
      id === "chromium"
        ? noBrowserHint("Chromium")
        : "Indica la ruta del ejecutable con --browser, o no indiques ninguno para usar el primero que haya.",
    );
  }
  const paths = system.platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(wanted)) {
    throw new CuyError(
      "INVALID_PARAMS",
      `Navegador desconocido: ${wanted}.`,
      `Usa ${BROWSER_IDS.join(", ")} o la ruta absoluta del ejecutable.`,
    );
  }
  const executablePath = customPath(wanted, system);
  const key = createHash("sha256").update(executablePath).digest("hex").slice(0, 8);
  return [{ id: "custom", name: paths.basename(executablePath), executablePath, profileKey: `custom-${key}` }];
}

/** Donde descarga install-browser. Se respeta PLAYWRIGHT_BROWSERS_PATH si la persona lo definió. */
export function browsersDir(): string {
  return join(homeDir(), "browsers");
}

interface RegistryExecutable {
  executablePath(): string | undefined;
}

interface RegistryModule {
  registry: {
    registry: {
      findExecutable(name: string): RegistryExecutable | undefined;
      install(executables: RegistryExecutable[], options?: { force?: boolean; gc?: boolean }): Promise<void>;
    };
    runOopDownloadBrowserMain(): void;
  };
}

/** Playwright fija su carpeta de navegadores al cargarse: hay que indicarla antes de importarlo. */
export async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= browsersDir();
  return import("playwright-core");
}

/** El registro interno de Playwright: sabe dónde va su Chromium y cómo descargarlo. */
export async function loadRegistry(): Promise<RegistryModule["registry"]> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= browsersDir();
  const mod = (await import("playwright-core/lib/coreBundle")) as RegistryModule;
  return mod.registry;
}

export async function playwrightChromiumPath(): Promise<string | null> {
  try {
    return (await loadRegistry()).registry.findExecutable("chromium")?.executablePath() ?? null;
  } catch {
    return null;
  }
}

export async function realSystem(): Promise<BrowserSystem> {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isExecutable,
    playwrightChromium: await playwrightChromiumPath(),
  };
}
