import { resolveElement } from "../element.js";
import type { Tab } from "../session.js";
import type { ConfirmKind } from "./policy.js";

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

const ACTIVE_ELEMENT = `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el || !document.hasFocus() || el.tagName === 'IFRAME' || el.tagName === 'FRAME') return null;
  return (${CLASSIFY}).call(el);
})()`;

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
  // El foco puede estar dentro de un iframe: solo el frame que lo tiene devuelve algo.
  let info: TargetInfo | null = null;
  for (const frame of tab.page.frames()) {
    info = (await frame.evaluate(ACTIVE_ELEMENT).catch(() => null)) as TargetInfo | null;
    if (info) break;
  }
  if (!info) return null;
  if (info.submit) return submitGate(tab, info, `con el botón ${pageText(info.text)}`);
  if (isEnter && info.implicit_submit) return submitGate(tab, info, "pulsando Enter");
  return null;
}

export function quotePageText(text: string): string {
  return pageText(text);
}
