import { isIP } from "node:net";
import type { Policy } from "./policy.js";

/** Como BrowserRules de WebKit: cubre hosts literales; el cliente valida DNS al navegar. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isIP(host) === 6 || !host.includes(".")) return true;
  if (["localhost", "local", "lan", "home", "internal", "home.arpa"].some((suffix) =>
    host === suffix || host.endsWith(`.${suffix}`))) return true;
  if (isIP(host) !== 4) return false;
  const [a = 0, b = 0, c = 0] = host.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && c === 0))) || (a === 198 && b >= 18 && b <= 19);
}

export function httpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

export function isLocalRequestAllowed(policy: Policy, target: string, source?: string): boolean {
  if (!policy.local_network) return true;
  const url = new URL(target);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol) || !isLocalHost(url.hostname)) return true;
  const allowed = policy.local_network.allow_origins;
  return allowed.includes(httpOrigin(target) ?? "") || allowed.includes(httpOrigin(source ?? "") ?? "");
}
