import { z } from "zod";
import { resolveElement, watchNavigation } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { typeGate } from "../core/security/classify.js";
import { classifySensitive, SENSITIVE_HINT } from "../core/security/sensitive.js";

const IS_EDITABLE = `function(){
  if(this.disabled||this.readOnly)return false;
  if(this.isContentEditable||this.tagName==='TEXTAREA')return true;
  return this.tagName==='INPUT'&&!['checkbox','radio','button','submit','file','image','reset','range','color','hidden'].includes(this.type);
}`;

const HAS_FOCUS = `function(){
  let active=document.activeElement;
  while(active&&active.shadowRoot&&active.shadowRoot.activeElement)active=active.shadowRoot.activeElement;
  return active===this;
}`;

const SELECT_ALL = `function(){
  if(this.select)this.select();
  else getSelection().selectAllChildren(this);
}`;

const CARET_TO_END = `function(){
  try{
    if(this.setSelectionRange)this.setSelectionRange(this.value.length,this.value.length);
    else{getSelection().selectAllChildren(this);getSelection().collapseToEnd();}
  }catch{}
}`;

export default defineTool({
  name: "type",
  description: "Escribe texto en un campo identificado por su ref. Rechaza los campos sensibles.",
  params: z.strictObject({
    ref: z.string().describe("Ref del campo."),
    text: z.string().describe("Texto que se escribe."),
    clear: z.boolean().default(false).describe("Borra el contenido actual antes de escribir."),
    submit: z.boolean().default(false).describe("Pulsa Enter al terminar."),
  }),
  risk: "action",
  cli: { positional: ["ref", "text"] },
  auditRedact: ["text"],
  gate: ({ session }, { ref, text, submit }) => typeGate(session.activeTab(), ref, text, submit),
  handler: async ({ session, warnings, policy }, { ref, text, clear, submit }) => {
    const tab = session.activeTab();
    const element = await resolveElement(tab, ref);
    try {
      const kind = classifySensitive(await element.attributes());
      if (kind && policy.sensitive_fields.block_typing) {
        throw new CuyError(
          "SENSITIVE_FIELD",
          `La escritura en ${ref} está bloqueada: es un campo sensible (${kind}).`,
          SENSITIVE_HINT,
        );
      }
      if (!(await element.call<boolean>(IS_EDITABLE))) throw element.notInteractable("no es editable");

      await element.scrollIntoView();
      await element.focus();
      // Sin foco confirmado, el texto podría acabar en otro campo.
      if (!(await element.call<boolean>(HAS_FOCUS))) throw element.notInteractable("no acepta el foco");

      if (clear) {
        await element.call(SELECT_ALL);
        await tab.page.keyboard.press("Delete");
      } else {
        await element.call(CARET_TO_END);
      }
      await tab.page.keyboard.type(text);

      if (!submit) return { navigated: false, url: tab.page.url() };
      return await watchNavigation(tab, () => session.tabIds(), warnings, () =>
        tab.page.keyboard.press("Enter"),
      );
    } finally {
      await element.dispose();
    }
  },
});
