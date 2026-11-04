import type { BrowserContext } from "playwright-core";

export type BrowserMode = "launch";

export interface StartOptions {
  mode: BrowserMode;
  profile: string;
  headless: boolean;
}

/** Punto único de acceso al navegador; attach y extension añadirán otras implementaciones. */
export interface BrowserDriver {
  readonly mode: BrowserMode;
  readonly profile: string;
  start(): Promise<BrowserContext>;
  stop(): Promise<void>;
}
