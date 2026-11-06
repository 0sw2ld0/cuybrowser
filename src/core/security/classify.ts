import type { Frame, Page } from "playwright-core";
import { resolveElement } from "../element.js";
import type { Tab } from "../session.js";
import type { ConfirmKind } from "./policy.js";
import { classifySensitive, type SensitiveKind } from "./sensitive.js";

export interface Gate {
  kinds: ConfirmKind[];
  description: string;
}

export interface TargetInfo {
  submit: boolean;
  implicit_submit: boolean;
  form: string;
  text: string;
}

export const PURCHASE_TEXT =
  /\b(pagar|comprar|compra ahora|finalizar compra|realizar pedido|confirmar pedido|checkout|pay|pay now|buy|buy now|purchase|place order|complete order)\b/i;
const PURCHASE_URL = /(checkout|payment|\/pago|\/pagar|\/cart\/pay)/i;

const CLASSIFY = `function(){
  const control=this.closest?.('button,input,a,[role=button],[role=link]')||this;
  const tag=control.tagName;
  const type=(control.getAttribute?.('type')||'').toLowerCase();
  const form=control.form||control.closest?.('form')||null;
  const isSubmitButton=(tag==='BUTTON'&&control.type==='submit')||(tag==='INPUT'&&(type==='submit'||type==='image'));
  const isTextInput=tag==='INPUT'&&!['checkbox','radio','button','reset','file','hidden','range','color','submit','image'].includes(type);
  const label=form?(form.getAttribute('aria-label')||form.getAttribute('name')||form.getAttribute('id')||''):'';
  const text=control.innerText||control.value||control.getAttribute?.('aria-label')||'';
  return {submit:Boolean(form&&isSubmitButton),implicit_submit:Boolean(form&&isTextInput),form:String(label),text:String(text)};
}`;

const ATTRIBUTES = `function(){
  const attrs={};
  for(const attr of this.attributes??[])attrs[attr.name]=attr.value;
  return attrs;
}`;

/** Se ejecuta en el documento padre de un iframe. */
function isFocusedFrame(owner: Element): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active === owner;
}

/**
 * Sigue el foco desde el documento principal hasta el iframe que lo tiene. No usa document.hasFocus(),
 * que en un iframe de otro sitio depende de que la ventana de Chrome esté activa.
 */
async function focusedFrame(page: Page): Promise<Frame> {
  let frame = page.mainFrame();
  for (let depth = 0; depth < 10; depth++) {
    let next: Frame | null = null;
    for (const child of frame.childFrames()) {
      const owner = await child.frameElement().catch(() => null);
      if (!owner) continue;
      const focused = await owner.evaluate(isFocusedFrame).catch(() => false);
      await owner.dispose();
      if (focused) {
        next = child;
        break;
      }
    }
    if (!next) return frame;
    frame = next;
  }
  return frame;
}

/** Ejecuta fn sobre el elemento con el foco, que puede estar dentro de un iframe o de shadow DOM abierto. */
async function onFocused<T>(tab: Tab, fn: string): Promise<T | null> {
  const frame = await focusedFrame(tab.page);
  const script = `(() => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
    return (${fn}).call(el);
  })()`;
  return ((await frame.evaluate(script).catch(() => null)) as T | null) ?? null;
}

/** Tipo de campo sensible que tiene el foco, o null. */
export async function focusedSensitiveKind(tab: Tab): Promise<SensitiveKind | null> {
  const attrs = await onFocused<Record<string, string>>(tab, ATTRIBUTES);
  return attrs ? classifySensitive(attrs) : null;
}

/** Recorta y limpia un texto de la página antes de mostrarlo en una solicitud de aprobación. */
function pageText(text: string): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim();
  return JSON.stringify(clean.length > 80 ? `${clean.slice(0, 80)}…` : clean);
}

function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function pageHost(tab: Tab): string {
  return host(tab.page.url());
}

function submitGate(tab: Tab, info: TargetInfo, how: string): Gate {
  const kinds: ConfirmKind[] = ["submit_forms"];
  if (PURCHASE_TEXT.test(info.text) || PURCHASE_URL.test(tab.page.url())) kinds.push("purchases");
  const form = info.form ? ` ${pageText(info.form)}` : "";
  return {
    kinds,
    description: `Enviar el formulario${form} en ${pageHost(tab)} ${how}.`,
  };
}

export async function clickGate(tab: Tab, ref: string): Promise<Gate | null> {
  const element = await resolveElement(tab, ref);
  try {
    const info = await element.call<TargetInfo>(CLASSIFY);
    const label = `con el botón ${pageText(info.text)}`;
    if (info.submit) return submitGate(tab, info, label);
    if (PURCHASE_TEXT.test(info.text)) {
      return {
        kinds: ["purchases"],
        description: `Pulsar ${pageText(info.text)}, que parece una compra o un pago, en ${pageHost(tab)}.`,
      };
    }
    return null;
  } finally {
    await element.dispose();
  }
}

export async function typeGate(tab: Tab, ref: string, text: string, submit: boolean): Promise<Gate | null> {
  // Un salto de línea en el texto equivale a pulsar Enter en un campo de una línea.
  if (!submit && !/[\r\n]/.test(text)) return null;
  const element = await resolveElement(tab, ref);
  try {
    const info = await element.call<TargetInfo>(CLASSIFY);
    return info.implicit_submit ? submitGate(tab, info, "pulsando Enter") : null;
  } finally {
    await element.dispose();
  }
}

export async function keyGate(tab: Tab, key: string): Promise<Gate | null> {
  const isEnter = /(^|\+)(Enter|NumpadEnter)$/i.test(key);
  const isSpace = /(^|\+)(Space| )$/i.test(key);
  if (!isEnter && !isSpace) return null;
  const info = await onFocused<TargetInfo>(tab, CLASSIFY);
  if (!info) return null;
  if (info.submit) return submitGate(tab, info, `con el botón ${pageText(info.text)}`);
  if (isEnter && info.implicit_submit) return submitGate(tab, info, "pulsando Enter");
  return null;
}

export function quotePageText(text: string): string {
  return pageText(text);
}
