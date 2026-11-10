import type { BrowserContext } from "playwright-core";
import type { BrowserCandidate } from "./browsers.js";

export type BrowserMode = "launch" | "attach";

export interface StartOptions {
  mode: BrowserMode;
  profile: string;
  headless: boolean;
  /** Solo en launch: id de BROWSER_IDS o ruta del ejecutable. Sin él, el primero instalado. */
  browser?: string;
  /** Solo en attach, ya validada por validateCdpUrl. */
  cdp_url?: string;
}

/** Punto único de acceso al navegador; extension añadirá otra implementación. */
export interface BrowserDriver {
  readonly mode: BrowserMode;
  /** Perfil aislado de CuyBrowser; null si el navegador no es suyo. */
  readonly profile: string | null;
  /** URL de depuración a la que se conectó, solo en attach. */
  readonly endpoint: string | null;
  /** Navegador abierto, solo en launch y después de start. */
  readonly browser: BrowserCandidate | null;
  start(): Promise<BrowserContext>;
  stop(): Promise<void>;
}
