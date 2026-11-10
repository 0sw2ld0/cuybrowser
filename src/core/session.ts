import type { BrowserContext, CDPSession, Dialog, Download, Frame, Page, Route } from "playwright-core";
import { AttachDriver, DEFAULT_CDP_URL } from "./driver/attach.js";
import { LaunchDriver } from "./driver/launch.js";
import type { BrowserDriver, StartOptions } from "./driver/types.js";
import { CuyError } from "./errors.js";
import { EventBuffer } from "./events.js";
import { hasDomainRules, isUrlAllowed, type Policy } from "./security/policy.js";
import { LocalNetworkProxy } from "./security/local-proxy.js";
import { OriginGuard } from "./security/origin-guard.js";
import { RefTable } from "./snapshot/refs.js";
import type { FlatLine } from "./snapshot/render.js";

export class Tab {
  originReady: Promise<void> = Promise.resolve();
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

  isMainFrame(frameId: string): boolean {
    return frameId === this.mainFrameId;
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
  private originGuard: OriginGuard | null = null;
  private localProxy: LocalNetworkProxy | null = null;
  private readonly consumedVisits = new Set<string>();
  private readonly activeVisits = new Map<Page, { id: string; origin: string }>();
  private headless = false;
  private handoffAbort: AbortController | null = null;

  get handingOff(): boolean { return this.handoffAbort !== null; }

  beginHandoff(): AbortController {
    this.requireContext();
    if (this.headless) {
      throw new CuyError("INVALID_PARAMS", "El relevo necesita una ventana: inicia el navegador sin headless.");
    }
    if (this.handoffAbort) throw new CuyError("HANDOFF_ACTIVE", "Ya hay un relevo esperando a la persona.");
    return (this.handoffAbort = new AbortController());
  }

  finishHandoff(abort: AbortController): void {
    if (this.handoffAbort === abort) this.handoffAbort = null;
  }

  private viewport: { width: number; height: number } | null = null;

  async setViewport(size: { width: number; height: number }): Promise<void> {
    await this.activeTab().page.setViewportSize(size);
    this.viewport = { ...size };
  }

  private readonly guardNavigation = async (route: Route): Promise<void> => {
    const request = route.request();
    let page: Page | undefined;
    let crossFrame = false;
    try {
      const frame = request.frame();
      page = frame.page();
      const parent = frame.parentFrame();
      crossFrame = parent !== null && new URL(parent.url()).origin !== new URL(request.url()).origin;
    } catch { /* Los workers no tienen frame: no reciben excepciones por el origen de la página. */ }
    const unprotected = this.originGuard && request.isNavigationRequest()
      && (!page || !this.originGuard.isReady(page) || crossFrame);
    if (unprotected || (request.isNavigationRequest() && this.policy
      && !isUrlAllowed(this.effectivePolicy(), request.url()))) {
      // "aborted" deja la página donde estaba; "blockedbyclient" la cambiaría por una página de error.
      const tab = [...this.tabs.values()].find((candidate) => candidate.page === page);
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
    if (this.context && !this.originGuard && (policy.origins || policy.local_network)) {
      await this.stop();
      throw new CuyError("BLOCKED_BY_POLICY", "La nueva barrera necesita reiniciar el navegador con la política activa.");
    }
    this.policy = policy;
    if (!this.context) return;
    for (const tab of this.tabs.values()) this.visitNavigation(tab.page, tab.page.url());
    const wanted = hasDomainRules(policy);
    if (wanted && !this.routed) {
      await this.context.route("**/*", this.guardNavigation);
      this.routed = true;
    } else if (!wanted && this.routed) {
      await this.context.unroute("**/*", this.guardNavigation);
      this.routed = false;
    }
  }

  /** warnings recibe los avisos del arranque, como haber usado otro navegador porque el primero falló. */
  async start(options: StartOptions, warnings: string[] = []): Promise<boolean> {
    if (this.running) return false;
    const protectedMode = this.policy?.origins !== undefined || this.policy?.local_network !== undefined;
    if (protectedMode && options.mode === "attach") {
      throw new CuyError("BLOCKED_BY_POLICY", "La barrera por origen requiere launch con un perfil propio, no attach.");
    }
    if (this.policy?.local_network) this.localProxy = new LocalNetworkProxy(() => this.policy!);
    const proxy = await this.localProxy?.start();
    const driver =
      options.mode === "attach"
        ? new AttachDriver(options.cdp_url ?? DEFAULT_CDP_URL)
        : new LaunchDriver(options, warnings, protectedMode, proxy);
    this.driver = driver;
    let context: BrowserContext;
    try { context = await driver.start(); } catch (error) { await this.stop(); throw error; }
    this.context = context;
    this.headless = options.mode === "launch" && options.headless;
    this.routed = false;
    if (protectedMode) {
      this.originGuard = new OriginGuard(context, () => this.effectivePolicy(), (page, url) => {
        const tab = [...this.tabs.values()].find((candidate) => candidate.page === page);
        if (tab) tab.blockedUrl = url;
      }, (page, url) => this.visitNavigation(page, url));
    }
    context.on("page", (page) => this.register(page));
    context.on("close", () => {
      if (this.context === context) this.reset();
    });
    for (const page of context.pages()) this.register(page);
    try {
      if (this.policy) await this.applyDomainRules(this.policy);
      await Promise.all([...this.tabs.values()].map((tab) => tab.originReady));
    } catch (error) {
      await this.stop();
      throw new CuyError("BLOCKED_BY_POLICY", "No se pudo instalar la barrera del navegador: " + String(error));
    }
    // Las pestañas que ya estaban son de la persona: el agente trabaja en una propia salvo que elija otra.
    if (options.mode === "attach") await this.newTab();
    return true;
  }

  async stop(): Promise<void> {
    const driver = this.driver;
    const proxy = this.localProxy;
    try { await driver?.stop(); } finally { this.reset(); await proxy?.close(); }
  }

  private reset(): void {
    for (const visit of this.activeVisits.values()) this.consumeVisit(visit.id);
    this.activeVisits.clear();
    this.originGuard?.close();
    this.originGuard = null;
    const proxy = this.localProxy; this.localProxy = null; void proxy?.close();
    this.handoffAbort?.abort();
    this.handoffAbort = null;
    this.headless = false;
    this.driver = null;
    this.context = null;
    this.routed = false;
    this.tabs.clear();
    this.viewport = null;
    this.activeId = null;
  }

  private register(page: Page): Tab {
    const existing = [...this.tabs.values()].find((tab) => tab.page === page);
    if (existing) return existing;
    const tab = new Tab(`t${++this.tabCounter}`, page);
    this.tabs.set(tab.id, tab);
    if (this.originGuard) {
      tab.originReady = this.originGuard.prepare(page);
      void tab.originReady.catch(() => page.close().catch(() => {}));
    }
    this.activeId ??= tab.id;
    this.recordEvents(tab);
    page.on("close", () => {
      const visit = this.activeVisits.get(page);
      if (visit) this.consumeVisit(visit.id);
      this.activeVisits.delete(page);
      if (this.activeId === tab.id) this.handoffAbort?.abort();
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
      if (this.originGuard) return; // CDP detiene cada salto antes de enviarlo, no después de observarlo.
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
    // Las excepciones no capturadas no llegan como mensaje de consola.
    page.on("pageerror", (error) => {
      this.events.push("console", id, { level: "error", text: `${error.name}: ${error.message}`, uncaught: true });
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

  private consumeVisit(id: string): void {
    if (this.consumedVisits.size < 1000) this.consumedVisits.add(id);
  }

  private effectivePolicy(): Policy {
    const policy = this.policy!;
    const visit = policy.origins?.visit;
    if (!visit || (!this.consumedVisits.has(visit.id) && this.consumedVisits.size < 1000)) return policy;
    const { visit: _expired, ...origins } = policy.origins!;
    return { ...policy, origins };
  }

  private visitNavigation(page: Page, value: string): void {
    let origin: string;
    try { origin = new URL(value).origin; } catch { return; }
    const active = this.activeVisits.get(page);
    if (active && active.origin !== origin) {
      this.consumeVisit(active.id); this.activeVisits.delete(page);
    }
    const visit = this.effectivePolicy().origins?.visit;
    if (visit?.origin === origin) this.activeVisits.set(page, visit);
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
    if (this.viewport) await page.setViewportSize(this.viewport);
    const tab = this.register(page);
    await tab.originReady;
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
    if (!this.running || !this.driver) return { running: false, tabs: [], consumed_visits: [...this.consumedVisits] };
    return {
      running: true,
      consumed_visits: [...this.consumedVisits],
      handing_off: this.handingOff,
      mode: this.driver.mode,
      ...(this.driver.browser === null
        ? {}
        : { browser: this.driver.browser.name, browser_path: this.driver.browser.executablePath }),
      ...(this.driver.profile === null ? {} : { profile: this.driver.profile }),
      ...(this.driver.endpoint === null ? {} : { cdp_url: this.driver.endpoint }),
      active_tab: this.activeId,
      tabs: await this.listTabs(),
    };
  }
}
