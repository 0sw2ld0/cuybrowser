import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";

const SELECT = `function(value,label){
  if(this.tagName!=='SELECT')return {error:'not_select'};
  if(this.disabled)return {error:'disabled'};
  const options=[...this.options];
  const option=options.find((o)=>value!==null?o.value===value:o.label===label||o.text.trim()===label);
  if(!option||option.disabled)return {error:'no_option',options:options.filter((o)=>!o.disabled).map((o)=>o.label)};
  this.value=option.value;
  this.dispatchEvent(new Event('input',{bubbles:true}));
  this.dispatchEvent(new Event('change',{bubbles:true}));
  return {value:option.value,label:option.label};
}`;

interface SelectResult {
  error?: "not_select" | "disabled" | "no_option";
  options?: string[];
  value?: string;
  label?: string;
}

export default defineTool({
  name: "select_option",
  description:
    "Elige una opción de un <select> nativo por value o label. En listas personalizadas usa click sobre la opción.",
  params: z.strictObject({
    ref: z.string().describe("Ref del <select>."),
    value: z.string().optional().describe("Valor de la opción."),
    label: z.string().optional().describe("Texto visible de la opción."),
  }),
  risk: "action",
  cli: { positional: ["ref"] },
  handler: async ({ session }, { ref, value, label }) => {
    if ((value === undefined) === (label === undefined)) {
      throw new CuyError("INVALID_PARAMS", "Indica value o label, no ambos.");
    }
    const element = await resolveElement(session.activeTab(), ref);
    try {
      const result = await element.call<SelectResult>(SELECT, value ?? null, label ?? null);
      if (result.error === "not_select") {
        throw element.notInteractable("no es un <select> nativo; abre la lista con click y elige la opción");
      }
      if (result.error === "disabled") throw element.notInteractable("está deshabilitado");
      if (result.error === "no_option") {
        throw new CuyError(
          "INVALID_PARAMS",
          `La opción no existe. Opciones disponibles: ${(result.options ?? []).join(", ")}`,
        );
      }
      return { value: result.value, label: result.label };
    } finally {
      await element.dispose();
    }
  },
});
