import { createInterface } from "node:readline/promises";
import {
  loadRegistry,
  PLAYWRIGHT_CHROMIUM_NAME,
  PLAYWRIGHT_CHROMIUM_SIZE,
  realSystem,
} from "./browsers.js";

/**
 * Playwright descarga en un proceso hijo que lanza con fork(). En el binario compilado ese hijo es el
 * propio binario con la ruta de oopBrowserDownload.js como argumento: hay que reconocerlo y atenderlo.
 */
export function isDownloadChild(
  argv: readonly string[] = process.argv,
  forked: boolean = typeof process.send === "function",
): boolean {
  return forked && argv.slice(1).some((arg) => /oopBrowserDownload\.js$/.test(arg));
}

export async function runDownloadChild(): Promise<void> {
  (await loadRegistry()).runOopDownloadBrowserMain();
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(s|si|sí|y|yes)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Descarga el Chromium de Playwright, solo cuando la persona lo pide con install-browser. */
export async function installBrowser(options: { yes: boolean }): Promise<number> {
  const system = await realSystem();
  const path = system.playwrightChromium;
  if (!path) {
    console.error(`Playwright no ofrece un Chromium para este sistema (${process.platform} ${process.arch}).`);
    return 1;
  }
  if (system.isExecutable(path)) {
    console.log(`El ${PLAYWRIGHT_CHROMIUM_NAME} ya está instalado en ${path}`);
    return 0;
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        `Se descargaría el ${PLAYWRIGHT_CHROMIUM_NAME} (${PLAYWRIGHT_CHROMIUM_SIZE}). Ejecuta de nuevo con --yes para confirmarlo.`,
      );
      return 1;
    }
    const ok = await askYesNo(`Se descargará el ${PLAYWRIGHT_CHROMIUM_NAME} (${PLAYWRIGHT_CHROMIUM_SIZE}). ¿Continuar? [s/N] `);
    if (!ok) {
      console.error("Cancelado: no se descargó nada.");
      return 1;
    }
  }
  const { registry } = await loadRegistry();
  const executable = registry.findExecutable("chromium");
  if (!executable) {
    console.error("Esta versión de Playwright no sabe instalar Chromium.");
    return 1;
  }
  // Sin gc: el binario compilado no puede leer la lista de navegadores de otras instalaciones de Playwright.
  await registry.install([executable], { gc: false });
  if (!system.isExecutable(path)) {
    console.error(`La descarga terminó, pero no aparece ${path}.`);
    return 1;
  }
  console.log(`Listo: ${PLAYWRIGHT_CHROMIUM_NAME} en ${path}`);
  console.log("CuyBrowser lo usará cuando no encuentre otro navegador, o con --browser chromium.");
  return 0;
}
