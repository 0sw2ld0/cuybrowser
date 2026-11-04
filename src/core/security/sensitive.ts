export type SensitiveKind = "password" | "tarjeta" | "cvv" | "código";

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
