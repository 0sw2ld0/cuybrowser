import type { BrowserContext, CDPSession, Dialog, Download, Frame, Page, Route } from "playwright-core";
import { LaunchDriver } from "./driver/launch.js";
import type { BrowserDriver, StartOptions } from "./driver/types.js";
import { CuyError } from "./errors.js";
import { EventBuffer } from "./events.js";
import { hasDomainRules, isUrlAllowed, type Policy } from "./security/policy.js";
import { RefTable } from "./snapshot/refs.js";
import type { FlatLine } from "./snapshot/render.js";

export class Tab {
  readonly refs = new RefTable();
  dialog: Dialog | null = null;
  blockedUrl: string | null = null;
  /** Termina cuando la pestaña deja de cancelar una redirección prohibida. */
  cancelledNavigation: Promise<void> = Promise.resolve();
  /** Último snapshot, para calcular el modo diff. */
  lastSnapshot: { signature: string; lines: FlatLine[] } | null = null;
  private frameKeys = new Map<string, string>();
  private frames = new Map<string, { session: CDPSession; frame?: Frame }>();
  private frameCounter = 0;
  private mainFrameId: string | null = null;
  private session: Promise<CDPSession> | null = null;
  private dialogListeners = new Set<(dialog: Dialog) => void>();

  constructor(
    readonly id: string,
    readonly page: Page,
  ) {}

  cdp(): Promise<CDPSession> {
    this.session ??= this.openSession();
    return this.session;
  }

  onDialog(listener: (dialog: Dialog) => void): () => void {
    this.dialogListeners.add(listener);
    return () => this.dialogListeners.delete(listener);
  }

  setDialog(dialog: Dialog): void {
    this.dialog = dialog;
    for (const listener of this.dialogListeners) listener(dialog);
  }

  private async openSession(): Promise<CDPSession> {
    const cdp = await this.page.context().newCDPSession(this.page);
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("DOM.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Accessibility.enable"),
    ]);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    this.mainFrameId = frameTree.frame.id;
    this.frames.set("", { session: cdp });
    this.watchNavigations(cdp);
    return cdp;
  }

  /** Solo la navegación entre documentos invalida las refs; pushState las conserva. */
  private watchNavigations(session: CDPSession): void {
    session.on("Page.frameNavigated", (event) => {
      const { id } = event.frame;
      if (id === this.mainFrameId) {
        this.refs.invalidate();
        this.lastSnapshot = null;
      } else {
        const key = this.frameKeys.get(id);
        if (key !== undefined) this.refs.invalidate(key);
      }
    });
  }

  /** Clave corta de un iframe, que se usa como prefijo de sus refs. */
  frameKey(frameId: string, session: CDPSession): string {
    let key = this.frameKeys.get(frameId);
    if (key === undefined) {
      key = `f${++this.frameCounter}`;
      this.frameKeys.set(frameId, key);
    }
    const known = this.frames.get(key);
    if (!known || known.session !== session) this.frames.set(key, { session });
    return key;
  }

  sessionFor(frameKey: string): CDPSession | null {
    return this.frames.get(frameKey)?.session ?? null;
  }

  /** Busca la sesión de un iframe de otro proceso entre los frames de la página. */
  async remoteFrameSession(frameId: string): Promise<CDPSession | null> {
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const session = await this.page.context().newCDPSession(frame).catch(() => null);
      if (!session) continue;
      const tree = await session.send("Page.getFrameTree").catch(() => null);
      if (tree?.frameTree.frame.id !== frameId) {
        await session.detach().catch(() => {});
        continue;
      }
      await Promise.all([
        session.send("Page.enable"),
        session.send("DOM.enable"),
        session.send("Runtime.enable"),
        session.send("Accessibility.enable"),
      ]);
      this.watchNavigations(session);
      const key = this.frameKey(frameId, session);
      this.frames.set(key, { session, frame });
      return session;
    }
    return null;
  }

  isRemoteFrame(frameKey: string): boolean {
    return this.frames.get(frameKey)?.frame !== undefined;
  }

  /** Desplazamiento hasta el viewport principal. Solo los iframes de otro proceso dan coordenadas propias. */
  async frameOffset(frameKey: string): Promise<{ x: number; y: number }> {
    const frame = this.frames.get(frameKey)?.frame;
    if (!frame) return { x: 0, y: 0 };
    const owner = await frame.frameElement();
    const box = await owner.boundingBox();
    const border = (await owner.evaluate((el) => ({ x: (el as Element).clientLeft, y: (el as Element).clientTop }))) as { x: number; y: number };
    await owner.dispose();
    return { x: (box?.x ?? 0) + border.x, y: (box?.y ?? 0) + border.y };
  }
}

export class Session {
  readonly events = new EventBuffer();
  onDownload: (tab: Tab, download: Download) => void = () => {};
  private driver: BrowserDriver | null = null;
  private context: BrowserContext | null = null;
  private tabs = new Map<string, Tab>();
  private activeId: string | null = null;
  private tabCounter = 0;
  private policy: Policy | null = null;
  private routed = false;

  private readonly guardNavigation = async (route: Route): Promise<void> => {
    const request = route.request();
    if (request.isNavigationRequest() && this.policy && !isUrlAllowed(this.policy, request.url())) {
      // "aborted" deja la página donde estaba; "blockedbyclient" la cambiaría por una página de error.
      const tab = [...this.tabs.values()].find((candidate) => candidate.page === request.frame().page());
      if (tab) tab.blockedUrl = request.url();
      await route.abort("aborted");
    } else {
      await route.fallback();
    }
  };

  get running(): boolean {
    return this.context !== null;
  }

  /** Solo intercepta si hay reglas, porque interceptar desactiva la caché HTTP de Chrome. */
  async applyDomainRules(policy: Policy): Promise<void> {
    this.policy = policy;
    if (!this.context) return;
    const wanted = hasDomainRules(policy);
    if (wanted && !this.routed) {
      await this.context.route("**/*", this.guardNavigation);
      this.routed = true;
    } else if (!wanted && this.routed) {
      await this.context.unroute("**/*", this.guardNavigation);
      this.routed = false;
    }
  }

  async start(options: StartOptions): Promise<boolean> {
    if (this.running) return false;
    const driver = new LaunchDriver(options);
    const context = await driver.start();
    this.driver = driver;
    this.context = context;
    this.routed = false;
    if (this.policy) await this.applyDomainRules(this.policy);
    context.on("page", (page) => this.register(page));
    context.on("close", () => {
      if (this.context === context) this.reset();
    });
    for (const page of context.pages()) this.register(page);
    return true;
  }

  async stop(): Promise<void> {
    const driver = this.driver;
    this.reset();
    await driver?.stop();
  }

  private reset(): void {
    this.driver = null;
    this.context = null;
    this.routed = false;
    this.tabs.clear();
    this.activeId = null;
  }

  private register(page: Page): Tab {
    const existing = [...this.tabs.values()].find((tab) => tab.page === page);
    if (existing) return existing;
    const tab = new Tab(`t${++this.tabCounter}`, page);
    this.tabs.set(tab.id, tab);
    this.activeId ??= tab.id;
    this.recordEvents(tab);
    page.on("close", () => {
      this.tabs.delete(tab.id);
      if (this.activeId === tab.id) {
        this.activeId = [...this.tabs.keys()].at(-1) ?? null;
      }
    });
    return tab;
  }

  private recordEvents(tab: Tab): void {
    const { id, page } = tab;
    // Playwright no intercepta los saltos de una redirección: se cancela la navegación al detectarlos.
    page.on("request", (request) => {
      if (!request.redirectedFrom() || !request.isNavigationRequest() || !this.policy) return;
      if (isUrlAllowed(this.policy, request.url())) return;
      tab.blockedUrl = request.url();
      tab.cancelledNavigation = request
        .frame()
        .goto("about:blank")
        .then(
          () => {},
          () => {},
        );
    });
    page.on("console", (message) => {
      this.events.push("console", id, { level: message.type(), text: message.text() });
    });
    page.on("response", (response) => {
      const request = response.request();
      this.events.push("network", id, {
        url: response.url(),
        method: request.method(),
        status: response.status(),
        failed: response.status() >= 400,
        resource_type: request.resourceType(),
      });
    });
    page.on("requestfailed", (request) => {
      this.events.push("network", id, {
        url: request.url(),
        method: request.method(),
        status: null,
        failed: true,
        error: request.failure()?.errorText ?? "desconocido",
        resource_type: request.resourceType(),
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.events.push("navigation", id, { url: frame.url() });
    });
    page.on("dialog", (dialog) => {
      this.events.push("dialog", id, { kind: dialog.type(), message: dialog.message() });
      tab.setDialog(dialog);
    });
    page.on("download", (download) => this.onDownload(tab, download));
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new CuyError("NO_BROWSER", "El navegador no está iniciado.", "Ejecuta start.");
    }
    return this.context;
  }

  currentTab(): Tab | null {
    return this.activeId ? (this.tabs.get(this.activeId) ?? null) : null;
  }

  activeTab(): Tab {
    this.requireContext();
    const tab = this.currentTab();
    if (!tab) throw new CuyError("NO_TAB", "No hay ninguna pestaña activa.", "Abre una con tab_new.");
    return tab;
  }

  private tabById(id: string): Tab {
    this.requireContext();
    const tab = this.tabs.get(id);
    if (!tab) throw new CuyError("NO_TAB", `La pestaña ${id} no existe.`, "Consulta tabs_list.");
    return tab;
  }

  tabIds(): string[] {
    return [...this.tabs.keys()];
  }

  async listTabs() {
    this.requireContext();
    return Promise.all(
      [...this.tabs.values()].map(async (tab) => ({
        id: tab.id,
        // Pedir el título de una página bloqueada por un diálogo no terminaría nunca.
        title: tab.dialog ? "" : await tab.page.title().catch(() => ""),
        url: tab.page.url(),
        active: tab.id === this.activeId,
      })),
    );
  }

  async newTab(): Promise<Tab> {
    const page = await this.requireContext().newPage();
    const tab = this.register(page);
    this.activeId = tab.id;
    return tab;
  }

  async selectTab(id: string): Promise<void> {
    const tab = this.tabById(id);
    if (!tab.dialog) await tab.page.bringToFront();
    this.activeId = tab.id;
  }

  async closeTab(id?: string): Promise<void> {
    const tab = id === undefined ? this.activeTab() : this.tabById(id);
    await tab.page.close();
  }

  async status() {
    if (!this.running || !this.driver) return { running: false, tabs: [] };
    return {
      running: true,
      mode: this.driver.mode,
      profile: this.driver.profile,
      active_tab: this.activeId,
      tabs: await this.listTabs(),
    };
  }
}
