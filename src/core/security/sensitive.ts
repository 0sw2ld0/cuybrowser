export type SensitiveKind = "password" | "tarjeta" | "cvv" | "código";

export const SENSITIVE_HINT = "Pide a la persona usuaria que lo complete directamente en el navegador.";

/** Teclas que no escriben ni borran nada en un campo, así que se pueden pulsar con el foco en uno sensible. */
const NON_WRITING_KEYS = new Set([
  "tab",
  "escape",
  "enter",
  "numpadenter",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "home",
  "end",
  "pageup",
  "pagedown",
  "shift",
  "control",
  "alt",
  "meta",
  "controlormeta",
]);

/** La tecla final de una combinación como Shift+Tab, separada con la misma regla que Playwright, que admite Control++. */
function mainKey(combo: string): string {
  const keys: string[] = [];
  let building = "";
  for (const char of combo) {
    if (char === "+" && building) {
      keys.push(building);
      building = "";
    } else {
      building += char;
    }
  }
  keys.push(building);
  return keys[keys.length - 1]!;
}

/** Lista de permitidas y no de prohibidas: también cuentan pegar, borrar y cualquier carácter. */
export function writesIntoField(combo: string): boolean {
  return !NON_WRITING_KEYS.has(mainKey(combo).toLowerCase());
}

const FIELD_NAME_CVV = /(^|[^a-z])(cvv|cvc|csc)([^a-z]|$)/i;
const FIELD_NAME_CARD = /card.?(num|no)|cc.?(num|number)|num.*tarjeta|tarjeta/i;

/** Clasifica un campo a partir de sus atributos HTML. Devuelve null si no parece sensible. */
export function classifySensitive(attrs: Record<string, string>): SensitiveKind | null {
  const type = (attrs.type ?? "").toLowerCase();
  const autocomplete = (attrs.autocomplete ?? "").toLowerCase();
  const identifier = `${attrs.name ?? ""} ${attrs.id ?? ""}`;

  if (type === "password" || /(current|new)-password/.test(autocomplete)) return "password";
  if (autocomplete.includes("cc-csc") || FIELD_NAME_CVV.test(identifier)) return "cvv";
  if (autocomplete.includes("cc-") || FIELD_NAME_CARD.test(identifier)) return "tarjeta";
  if (autocomplete.includes("one-time-code")) return "código";
  return null;
}
