import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectBrowsers,
  knownPaths,
  resolveBrowsers,
  type BrowserSystem,
} from "../../src/core/driver/browsers.js";
import { isDownloadChild } from "../../src/core/driver/install.js";
import { CuyError } from "../../src/core/errors.js";
import { profileDir } from "../../src/core/paths.js";
import { withClientDefaults } from "../../src/ipc/client.js";

const MAC = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  arc: "/Applications/Arc.app/Contents/MacOS/Arc",
};
const PLAYWRIGHT = "/Users/ana/.cuybrowser/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/** Un sistema simulado: solo existen los ejecutables de la lista. */
function system(files: string[], overrides: Partial<BrowserSystem> = {}): BrowserSystem {
  const present = new Set(files);
  return {
    platform: "darwin",
    env: {},
    home: "/Users/ana",
    isExecutable: (path) => present.has(path),
    playwrightChromium: PLAYWRIGHT,
    ...overrides,
  };
}

function names(system: BrowserSystem, choice?: string): string[] {
  return resolveBrowsers(choice, system).map((browser) => browser.name);
}

function errorOf(fn: () => unknown): CuyError {
  try {
    fn();
  } catch (err) {
    if (err instanceof CuyError) return err;
    throw err;
  }
  throw new Error("No lanzó ningún error");
}

describe("orden de los navegadores", () => {
  it("prefiere Chrome y deja el Chromium de Playwright para el final", () => {
    const all = system([...Object.values(MAC), PLAYWRIGHT]);
    expect(names(all)).toEqual([
      "Google Chrome",
      "Microsoft Edge",
      "Brave",
      "Chromium",
      "Arc",
      "Chromium de Playwright",
    ]);
  });

  it("sin Chrome, usa el siguiente que esté instalado", () => {
    expect(names(system([MAC.brave, MAC.arc]))).toEqual(["Brave", "Arc"]);
    expect(names(system([MAC.msedge, PLAYWRIGHT]))).toEqual(["Microsoft Edge", "Chromium de Playwright"]);
  });

  it("encuentra las aplicaciones de ~/Applications", () => {
    const own = "/Users/ana/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    expect(resolveBrowsers(undefined, system([own]))[0]?.executablePath).toBe(own);
  });

  it("usa el Chromium descargado cuando es el único", () => {
    const [only] = resolveBrowsers(undefined, system([PLAYWRIGHT]));
    expect(only).toMatchObject({ id: "chromium", name: "Chromium de Playwright", executablePath: PLAYWRIGHT });
  });

  it("sin ningún navegador, explica cómo descargar uno y no lo descarga", () => {
    const error = errorOf(() => resolveBrowsers(undefined, system([])));
    expect(error.code).toBe("NO_BROWSER");
    expect(error.message).toContain("Google Chrome, Microsoft Edge, Brave, Chromium o Arc");
    expect(error.hint).toContain("cuybrowser install-browser");
    expect(error.hint).toContain("nunca lo descarga por su cuenta");
  });

  it("no cuenta un Chromium de Playwright que aún no se descargó", () => {
    expect(detectBrowsers(system([MAC.chrome]))).toHaveLength(1);
    expect(detectBrowsers(system([], { playwrightChromium: null }))).toEqual([]);
  });
});

describe("navegador elegido a mano", () => {
  const all = system([...Object.values(MAC), PLAYWRIGHT]);

  it("usa solo el elegido, sin pasar a otro", () => {
    expect(names(all, "brave")).toEqual(["Brave"]);
    expect(names(all, "MSEDGE")).toEqual(["Microsoft Edge"]);
    expect(names(all, "auto")).toHaveLength(6);
  });

  it("chromium incluye el del sistema y después el descargado", () => {
    expect(names(all, "chromium")).toEqual(["Chromium", "Chromium de Playwright"]);
    expect(names(system([MAC.chrome, PLAYWRIGHT]), "chromium")).toEqual(["Chromium de Playwright"]);
  });

  it("avisa si el elegido no está instalado", () => {
    const error = errorOf(() => resolveBrowsers("arc", system([MAC.chrome])));
    expect(error.code).toBe("NO_BROWSER");
    expect(error.message).toContain("Arc no está instalado");
    expect(errorOf(() => resolveBrowsers("chromium", system([MAC.chrome]))).hint).toContain("install-browser");
  });

  it("acepta la ruta de un ejecutable y, en macOS, la de la aplicación", () => {
    const vivaldi = "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi";
    const custom = system([vivaldi]);
    expect(resolveBrowsers(vivaldi, custom)).toMatchObject([{ id: "custom", name: "Vivaldi", executablePath: vivaldi }]);
    expect(resolveBrowsers("/Applications/Vivaldi.app", custom)[0]?.executablePath).toBe(vivaldi);
    expect(resolveBrowsers("/Applications/Vivaldi.app/", custom)[0]?.executablePath).toBe(vivaldi);
  });

  it("rechaza nombres desconocidos, rutas relativas y rutas sin ejecutable", () => {
    expect(errorOf(() => resolveBrowsers("firefox", all)).code).toBe("INVALID_PARAMS");
    expect(errorOf(() => resolveBrowsers("./chrome", all)).code).toBe("INVALID_PARAMS");
    expect(errorOf(() => resolveBrowsers("/opt/nada/chrome", all)).code).toBe("NO_BROWSER");
  });
});

describe("rutas por sistema", () => {
  it("Linux busca en /opt y en /usr/bin, y no tiene Arc", () => {
    const linux = system(["/opt/brave.com/brave/brave", "/usr/bin/chromium-browser"], {
      platform: "linux",
      home: "/home/ana",
      playwrightChromium: null,
    });
    expect(names(linux)).toEqual(["Brave", "Chromium"]);
    expect(knownPaths("arc", linux)).toEqual([]);
    expect(knownPaths("chrome", linux)).toEqual(["/opt/google/chrome/chrome"]);
  });

  it("Windows busca en LOCALAPPDATA y en las dos carpetas de programas", () => {
    const env = {
      LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)\\",
    };
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const windows = system([edge], { platform: "win32", env, home: "C:\\Users\\ana", playwrightChromium: null });
    expect(knownPaths("chrome", windows)).toEqual([
      "C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
    expect(names(windows)).toEqual(["Microsoft Edge"]);
    expect(resolveBrowsers("C:\\Herramientas\\chrome.exe", system(["C:\\Herramientas\\chrome.exe"], { platform: "win32" }))).toHaveLength(1);
  });
});

describe("perfiles", () => {
  it("cada navegador tiene su carpeta y la de Chrome no cambia", () => {
    const all = system([...Object.values(MAC), PLAYWRIGHT]);
    const keys = resolveBrowsers(undefined, all).map((browser) => browser.profileKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(profileDir("default")).toBe(profileDir("default", "chrome"));
    expect(profileDir("default", "chrome").endsWith(join("profiles", "default"))).toBe(true);
    expect(profileDir("trabajo", "msedge").endsWith(join("profiles", "trabajo.msedge"))).toBe(true);
  });

  it("dos rutas propias distintas no comparten perfil", () => {
    const a = resolveBrowsers("/opt/a/chrome", system(["/opt/a/chrome"]))[0]!;
    const b = resolveBrowsers("/opt/b/chrome", system(["/opt/b/chrome"]))[0]!;
    expect(a.profileKey).toMatch(/^custom-[0-9a-f]{8}$/);
    expect(a.profileKey).not.toBe(b.profileKey);
  });
});

describe("CUYBROWSER_BROWSER", () => {
  afterEach(() => {
    delete process.env.CUYBROWSER_BROWSER;
  });

  it("lo aplica quien llama a start, salvo que se elija otro o sea attach", () => {
    process.env.CUYBROWSER_BROWSER = "brave";
    expect(withClientDefaults("start", { headless: true })).toEqual({ headless: true, browser: "brave" });
    expect(withClientDefaults("start", undefined)).toEqual({ browser: "brave" });
    expect(withClientDefaults("start", { browser: "msedge" })).toEqual({ browser: "msedge" });
    expect(withClientDefaults("start", { mode: "attach" })).toEqual({ mode: "attach" });
    expect(withClientDefaults("navigate", { url: "https://a.b" })).toEqual({ url: "https://a.b" });
  });

  it("sin la variable no cambia nada", () => {
    expect(withClientDefaults("start", { headless: true })).toEqual({ headless: true });
  });
});

describe("descarga del Chromium", () => {
  it("solo reconoce como hijo de descarga al proceso que lanza Playwright", () => {
    const argv = ["bun", "/$bunfs/root/cuybrowser", "/ruta/playwright-core/lib/entry/oopBrowserDownload.js"];
    expect(isDownloadChild(argv, true)).toBe(true);
    // Fuera de un fork no hay canal con el padre: nunca se confunde con una orden normal.
    expect(isDownloadChild(argv, false)).toBe(false);
    expect(isDownloadChild(["node", "cli.js", "install-browser"], true)).toBe(false);
  });
});
