import type { Browser, BrowserContext } from "playwright-core";
import { CuyError } from "../errors.js";
import { loadPlaywright } from "./browsers.js";
import type { BrowserDriver } from "./types.js";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Solo un Chrome de este mismo equipo: el puerto de depuración da control total sobre el navegador. */
export function validateCdpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CuyError("INVALID_PARAMS", `URL de depuración no válida: ${url}`, `Usa, por ejemplo, ${DEFAULT_CDP_URL}.`);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new CuyError("INVALID_PARAMS", `Esquema no permitido para la depuración: ${parsed.protocol}`, "Usa http:// o ws://.");
  }
  if (!LOOPBACK.has(parsed.hostname.toLowerCase())) {
    throw new CuyError(
      "INVALID_PARAMS",
      `Solo se admite un Chrome de este equipo, no ${parsed.hostname}.`,
      "Usa 127.0.0.1 o localhost.",
    );
  }
  return parsed.href;
}

/** Se conecta a un Chrome que ya abrió la persona usuaria con --remote-debugging-port. */
export class AttachDriver implements BrowserDriver {
  readonly mode = "attach" as const;
  readonly profile = null;
  /** El Chrome es de la persona: no se sabe cuál es ni dónde está. */
  readonly browser = null;
  private connection: Browser | null = null;

  constructor(readonly endpoint: string) {}

  async start(): Promise<BrowserContext> {
    const { chromium } = await loadPlaywright();
    try {
      this.connection = await chromium.connectOverCDP(this.endpoint, { timeout: 10_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CuyError(
        "NO_BROWSER",
        `No se pudo conectar con Chrome en ${this.endpoint}: ${message.split("\n")[0]}`,
        "Abre Chrome con --remote-debugging-port y un --user-data-dir propio, y comprueba la URL.",
      );
    }
    const context = this.connection.contexts()[0];
    if (!context) {
      await this.stop();
      throw new CuyError("NO_BROWSER", `El Chrome de ${this.endpoint} no tiene ninguna ventana abierta.`);
    }
    return context;
  }

  /** Solo se desconecta: el Chrome es de la persona usuaria y sigue abierto con sus pestañas. */
  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch(() => {});
  }
}
