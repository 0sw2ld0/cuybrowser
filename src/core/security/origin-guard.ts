import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { isUrlAllowed, type Policy } from "./policy.js";

/** Pausa cada documento, incluidos los saltos HTTP, antes de enviarlo a la red. */
export class OriginGuard {
  private readonly sessions = new Map<Page, Promise<CDPSession>>();
  private readonly ready = new WeakSet<Page>();

  constructor(private readonly context: BrowserContext, private readonly policy: () => Policy,
    private readonly blocked: (page: Page, url: string) => void,
    private readonly navigated: (page: Page, url: string) => void) {}

  isReady(page: Page): boolean { return this.ready.has(page); }
  close(): void { this.sessions.clear(); }

  async prepare(page: Page): Promise<void> {
    let pending = this.sessions.get(page);
    if (!pending) {
      pending = this.attach(page); this.sessions.set(page, pending);
      void pending.catch(() => page.close().catch(() => {}));
      page.once("close", () => { this.sessions.delete(page); this.ready.delete(page); });
    }
    await pending;
  }

  private async attach(page: Page): Promise<CDPSession> {
    const session = await this.context.newCDPSession(page);
    await session.send("Page.enable");
    const { frameTree } = await session.send("Page.getFrameTree");
    this.navigated(page, frameTree.frame.url);
    session.on("Page.frameNavigated", (event) => {
      if (event.frame.id === frameTree.frame.id) this.navigated(page, event.frame.url);
    });
    await session.send("Network.setBypassServiceWorker", { bypass: true });
    session.on("Fetch.requestPaused", (event) => {
      const allowed = isUrlAllowed(this.policy(), event.request.url);
      if (!allowed) this.blocked(page, event.request.url);
      const task = allowed ? session.send("Fetch.continueRequest", { requestId: event.requestId })
        : session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
      // Si continuar falla se cierra la página; nunca se hace un fallback que abra la red.
      void task.catch(() => page.close().catch(() => {}));
    });
    await session.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
    this.ready.add(page);
    return session;
  }
}
