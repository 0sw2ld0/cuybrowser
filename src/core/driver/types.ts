import type { BrowserContext } from "playwright-core";

export type BrowserMode = "launch" | "attach";

export interface StartOptions {
  mode: BrowserMode;
  profile: string;
  headless: boolean;
  /** Solo en attach, ya validada por validateCdpUrl. */
  cdp_url?: string;
}

/** Punto único de acceso al navegador; extension añadirá otra implementación. */
export interface BrowserDriver {
  readonly mode: BrowserMode;
  /** Perfil aislado de CuyBrowser; null si el Chrome no es suyo. */
  readonly profile: string | null;
  /** URL de depuración a la que se conectó, solo en attach. */
  readonly endpoint: string | null;
  start(): Promise<BrowserContext>;
  stop(): Promise<void>;
}
