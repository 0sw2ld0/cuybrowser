import type { CDPSession } from "playwright-core";
import { CuyError } from "./errors.js";
import { attributesToRecord } from "./snapshot/index.js";
import type { Tab } from "./session.js";

// Cada elemento usa su grupo: una herramienta interrumpida por un diálogo termina más tarde
// y no debe liberar los objetos de la siguiente.
let objectGroups = 0;

export class ResolvedElement {
  constructor(
    readonly tab: Tab,
    readonly ref: string,
    readonly backendNodeId: number,
    private readonly objectId: string,
    private readonly cdp: CDPSession,
    private readonly objectGroup: string,
    private readonly frameKey: string,
  ) {}

  async call<T>(fn: string, ...args: unknown[]): Promise<T> {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.callFunctionOn", {
      objectId: this.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new CuyError("INTERNAL", `Error al inspeccionar ${this.ref}: ${exceptionDetails.text}`);
    }
    return result.value as T;
  }

  async attributes(): Promise<Record<string, string>> {
    const { node } = await this.cdp.send("DOM.describeNode", { backendNodeId: this.backendNodeId });
    return attributesToRecord(node.attributes);
  }

  async scrollIntoView(): Promise<void> {
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: this.backendNodeId });
  }

  async focus(): Promise<void> {
    await this.cdp.send("DOM.focus", { backendNodeId: this.backendNodeId });
  }

  async box(): Promise<{ x: number; y: number; width: number; height: number }> {
    await this.scrollIntoView();
    const offset = await this.settledFrameOffset();
    const { quads } = await this.cdp
      .send("DOM.getContentQuads", { backendNodeId: this.backendNodeId })
      .catch(() => ({ quads: [] as number[][] }));
    const quad = quads[0];
    if (!quad) throw this.notInteractable("no tiene área visible");
    const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
    const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    if (width <= 0 || height <= 0) throw this.notInteractable("no tiene área visible");
    return { x: x + offset.x, y: y + offset.y, width, height };
  }

  /** Desplazar un iframe de otro proceso mueve la página principal de forma asíncrona: hay que esperar a que pare. */
  private async settledFrameOffset(): Promise<{ x: number; y: number }> {
    let offset = await this.tab.frameOffset(this.frameKey);
    if (!this.tab.isRemoteFrame(this.frameKey)) return offset;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = await this.tab.frameOffset(this.frameKey);
      const stable = next.x === offset.x && next.y === offset.y;
      offset = next;
      if (stable) break;
    }
    return offset;
  }

  /** Comprueba que el clic llegaría a este elemento y devuelve el punto donde hacerlo. */
  async clickablePoint(): Promise<{ x: number; y: number }> {
    if (
      await this.call<boolean>(
        "function(){return this.disabled===true||this.getAttribute?.('aria-disabled')==='true'}",
      )
    ) {
      throw this.notInteractable("está deshabilitado");
    }
    const box = await this.box();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Dentro de un iframe, la comprobación usa las coordenadas de su propio documento.
    const local =
      this.frameKey === ""
        ? { x, y }
        : await this.call<{ x: number; y: number }>(
            "function(){const r=this.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}}",
          );
    const receives = await this.call<boolean>(
      `function(x,y){
        let hit=document.elementFromPoint(x,y);
        while(hit&&hit.shadowRoot){
          const inner=hit.shadowRoot.elementFromPoint(x,y);
          if(!inner||inner===hit)break;
          hit=inner;
        }
        if(!hit)return false;
        for(let node=hit;node;node=node.parentNode||node.host){if(node===this)return true}
        const label=hit.closest?.('label');
        return Boolean(label&&(label===this||label.control===this||label.contains(this)));
      }`,
      local.x,
      local.y,
    );
    if (!receives) throw this.notInteractable("otro elemento lo tapa");
    if (this.frameKey !== "") {
      // Una capa de la página principal también podría quedarse con el clic.
      const top = await this.tab.page.evaluate(
        ([px, py]) => document.elementFromPoint(px as number, py as number)?.tagName ?? "",
        [x, y],
      );
      if (top !== "IFRAME" && top !== "FRAME") throw this.notInteractable("otro elemento tapa el iframe");
    }
    return { x, y };
  }

  notInteractable(reason: string): CuyError {
    return new CuyError(
      "NOT_INTERACTABLE",
      `No se puede interactuar con ${this.ref}: ${reason}.`,
      "Toma un snapshot nuevo y comprueba el estado de la página.",
    );
  }

  async dispose(): Promise<void> {
    await this.cdp.send("Runtime.releaseObjectGroup", { objectGroup: this.objectGroup }).catch(() => {});
  }
}

export async function resolveElement(tab: Tab, ref: string): Promise<ResolvedElement> {
  const { backendNodeId, frameKey } = tab.refs.resolve(ref);
  await tab.cdp();
  const cdp = tab.sessionFor(frameKey);
  const stale = () =>
    new CuyError("REF_STALE", `El elemento ${ref} ya no está en la página.`, "Toma un snapshot nuevo.");
  if (!cdp) throw stale();
  const objectGroup = `cuybrowser-${++objectGroups}`;
  let objectId: string | undefined;
  try {
    const { object } = await cdp.send("DOM.resolveNode", { backendNodeId, objectGroup });
    objectId = object.objectId;
  } catch {
    throw stale();
  }
  if (!objectId) throw stale();
  const element = new ResolvedElement(tab, ref, backendNodeId, objectId, cdp, objectGroup, frameKey);
  if (!(await element.call<boolean>("function(){return this.isConnected}"))) {
    await element.dispose();
    throw stale();
  }
  return element;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cuánto se espera a que salga la petición de una navegación que la página ya pidió. Entre una cosa y la otra
 * corren el beforeunload de la página y el trabajo del navegador, que en un equipo cargado pasa de 100 ms.
 */
const REQUESTED_NAVIGATION_GRACE_MS = 2_000;

/** Ejecuta una acción e informa de si provocó una navegación o abrió pestañas. */
export async function watchNavigation(
  tab: Tab,
  knownTabs: () => string[],
  warnings: string[],
  action: () => Promise<void>,
) {
  const page = tab.page;
  const tabsBefore = new Set(knownTabs());
  let requested = false;
  let settled = false;
  let committed = false;
  /** Chrome avisa en cuanto la página pide navegar, antes de que salga la petición de red. */
  let pendingSince: number | null = null;
  let sameDocument = false;
  const cdp = await tab.cdp();
  const onRequestedNavigation = (event: { frameId: string; disposition: string }) => {
    if (event.disposition === "currentTab" && tab.isMainFrame(event.frameId)) pendingSince ??= Date.now();
  };
  const onSameDocument = (event: { frameId: string }) => {
    if (tab.isMainFrame(event.frameId)) sameDocument = true;
  };
  const waiting = (): boolean => {
    if (committed || sameDocument) return false;
    if (requested) return true;
    // Pedida pero sin petición todavía. Si no sale en el margen, la página la canceló.
    return pendingSince !== null && Date.now() - pendingSince < REQUESTED_NAVIGATION_GRACE_MS;
  };
  const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  const onRequest = (request: Parameters<typeof isMainNavigation>[0]) => {
    if (isMainNavigation(request)) requested = true;
  };
  const onSettled = (request: Parameters<typeof isMainNavigation>[0]) => {
    if (isMainNavigation(request)) settled = true;
  };
  const onFrame = (frame: unknown) => {
    if (frame === page.mainFrame()) committed = true;
  };

  page.on("request", onRequest);
  page.on("requestfinished", onSettled);
  page.on("requestfailed", onSettled);
  page.on("framenavigated", onFrame);
  cdp.on("Page.frameRequestedNavigation", onRequestedNavigation);
  cdp.on("Page.navigatedWithinDocument", onSameDocument);
  tab.blockedUrl = null;
  try {
    await action();
    await sleep(100);
    const deadline = Date.now() + 10_000;
    let settledAt: number | null = null;
    while (waiting() && Date.now() < deadline) {
      if (settled) {
        settledAt ??= Date.now();
        if (Date.now() - settledAt > 100) break;
      }
      await sleep(25);
    }
    await tab.cancelledNavigation;
    if (tab.blockedUrl) {
      warnings.push(`La política bloqueó la navegación hacia ${tab.blockedUrl} y se canceló.`);
    }
    if (requested && !committed && !settled) {
      warnings.push("La navegación iniciada no se confirmó en 10 segundos.");
    }
    if (committed) {
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {
        warnings.push("La página nueva tarda en terminar de cargar.");
      });
    }
  } finally {
    page.off("request", onRequest);
    page.off("requestfinished", onSettled);
    page.off("requestfailed", onSettled);
    page.off("framenavigated", onFrame);
    cdp.off("Page.frameRequestedNavigation", onRequestedNavigation);
    cdp.off("Page.navigatedWithinDocument", onSameDocument);
  }
  return {
    navigated: committed,
    url: page.url(),
    title: await page.title().catch(() => ""),
    new_tabs: knownTabs().filter((id) => !tabsBefore.has(id)),
  };
}
