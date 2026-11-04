import type { CDPSession } from "playwright-core";
import { CuyError } from "../errors.js";
import { collectInjectionWarnings, wrapPageContent } from "../security/untrusted.js";
import type { Tab } from "../session.js";
import {
  ATTRIBUTE_ROLES,
  buildItems,
  cutLines,
  diffLines,
  estimateTokens,
  flatten,
  IFRAME_ROLES,
  renderWithBudget,
  type AxNode,
  type FrameDoc,
  type Item,
} from "./render.js";

export const DEFAULT_MAX_TOKENS = 8000;
const MAX_IFRAMES = 10;
const MAX_IFRAME_DEPTH = 3;
/** Si el diff no ahorra al menos esto frente al snapshot completo, no compensa. */
const DIFF_FALLBACK_RATIO = 0.6;

export interface SnapshotOptions {
  mode?: "full" | "diff";
  scope_ref?: string;
  interactive_only?: boolean;
  max_tokens?: number;
}

export function attributesToRecord(list: string[] | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let i = 0; list && i + 1 < list.length; i += 2) {
    attrs[list[i]!] = list[i + 1]!;
  }
  return attrs;
}

async function readAxTree(session: CDPSession, frameId?: string): Promise<AxNode[]> {
  const { nodes } = (await session.send("Accessibility.getFullAXTree", frameId ? { frameId } : {})) as unknown as {
    nodes: AxNode[];
  };
  return nodes;
}

interface Collector {
  tab: Tab;
  warnings: string[];
  iframes: number;
}

async function collectDoc(
  collector: Collector,
  session: CDPSession,
  nodes: AxNode[],
  frameKey: string,
  depth: number,
): Promise<FrameDoc> {
  const doc: FrameDoc = { frameKey, nodes, attributes: new Map(), children: new Map() };
  const frameElements: { backendNodeId: number; frameId: string }[] = [];

  await Promise.all(
    nodes.map(async (node) => {
      const role = typeof node.role?.value === "string" ? node.role.value : "";
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId === undefined || node.ignored) return;
      const isFrame = IFRAME_ROLES.has(role);
      if (!isFrame && !ATTRIBUTE_ROLES.has(role)) return;
      try {
        const described = await session.send("DOM.describeNode", { backendNodeId });
        doc.attributes.set(backendNodeId, attributesToRecord(described.node.attributes));
        if (isFrame && described.node.frameId) {
          frameElements.push({ backendNodeId, frameId: described.node.frameId });
        }
      } catch {
        // El nodo pudo desaparecer mientras se construía el snapshot.
      }
    }),
  );

  for (const { backendNodeId, frameId } of frameElements) {
    if (depth >= MAX_IFRAME_DEPTH || collector.iframes >= MAX_IFRAMES) {
      collector.warnings.push("La página tiene más iframes de los que se leen; algunos se omitieron.");
      break;
    }
    collector.iframes++;
    try {
      const child = await readFrame(collector, session, frameId, depth + 1);
      doc.children.set(backendNodeId, child);
    } catch {
      collector.warnings.push("No se pudo leer el contenido de un iframe.");
    }
  }
  return doc;
}

async function readFrame(collector: Collector, parent: CDPSession, frameId: string, depth: number): Promise<FrameDoc> {
  const { tab } = collector;
  try {
    // Un iframe del mismo proceso se lee con la sesión de su padre.
    const nodes = await readAxTree(parent, frameId);
    return await collectDoc(collector, parent, nodes, tab.frameKey(frameId, parent), depth);
  } catch {
    // Un iframe de otro sitio vive en otro proceso y necesita su propia sesión.
    const remote = await tab.remoteFrameSession(frameId);
    if (!remote) throw new Error("Frame no encontrado");
    const nodes = await readAxTree(remote);
    return await collectDoc(collector, remote, nodes, tab.frameKey(frameId, remote), depth);
  }
}

async function collectPage(tab: Tab, warnings: string[]): Promise<FrameDoc> {
  const cdp = await tab.cdp();
  return collectDoc({ tab, warnings, iframes: 0 }, cdp, await readAxTree(cdp), "", 0);
}

function pageText(doc: FrameDoc): string {
  const own = doc.nodes.map((node) => (typeof node.name?.value === "string" ? node.name.value : "")).join(" ");
  return [own, ...[...doc.children.values()].map(pageText)].join(" ");
}

function hasNode(doc: FrameDoc, frameKey: string, backendNodeId: number): boolean {
  if (doc.frameKey === frameKey && doc.nodes.some((node) => node.backendDOMNodeId === backendNodeId)) return true;
  return [...doc.children.values()].some((child) => hasNode(child, frameKey, backendNodeId));
}

export async function takeSnapshot(tab: Tab, options: SnapshotOptions, warnings: string[]) {
  const scope = options.scope_ref === undefined ? undefined : tab.refs.resolve(options.scope_ref);
  const doc = await collectPage(tab, warnings);
  if (scope && !hasNode(doc, scope.frameKey, scope.backendNodeId)) {
    throw new CuyError(
      "REF_STALE",
      `La ref ${options.scope_ref} ya no está en la página.`,
      "Toma un snapshot nuevo.",
    );
  }

  const url = tab.page.url();
  const title = await tab.page.title();
  const baseUrl = url;
  const items = buildItems({
    doc,
    baseUrl,
    interactiveOnly: options.interactive_only ?? false,
    ...(scope ? { scope } : {}),
  });
  const renderOptions = { refFor: (id: number, key: string) => tab.refs.refFor(id, key) };

  const header = `# ${url} — "${title.replace(/\s+/g, " ").replace(/"/g, '\\"')}"`;
  const maxTokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
  const full = renderWithBudget(items, renderOptions, maxTokens);
  const lines = flatten(items, renderOptions);

  // Solo son comparables dos snapshots pedidos con el mismo alcance.
  const signature = JSON.stringify([options.scope_ref ?? null, options.interactive_only ?? false]);
  const previous = tab.lastSnapshot?.signature === signature ? tab.lastSnapshot.lines : null;
  tab.lastSnapshot = { signature, lines };

  await collectInjectionWarnings(tab.page, pageText(doc), warnings);

  let mode: "full" | "diff" = "full";
  let body = full.text;
  let truncated = full.truncated;
  if (options.mode === "diff") {
    if (!previous) {
      warnings.push("diff_fallback: no hay un snapshot anterior comparable; se devuelve el completo.");
    } else {
      const diff = diffLines(previous, lines);
      const diffText = diff.length === 0 ? "(sin cambios)" : diff.join("\n");
      if (estimateTokens(diffText) > estimateTokens(full.text) * DIFF_FALLBACK_RATIO && diff.length > 0) {
        warnings.push("diff_fallback: el diff ocupa demasiado; se devuelve el snapshot completo.");
      } else {
        mode = "diff";
        truncated = estimateTokens(diffText) > maxTokens;
        body = truncated ? cutLines(diff, maxTokens).join("\n") : diffText;
      }
    }
  }
  if (truncated) warnings.push(`Snapshot recortado para no superar unos ${maxTokens} tokens.`);

  return {
    url,
    title,
    mode,
    truncated,
    tokens_estimated: estimateTokens(body),
    text: wrapPageContent(body ? `${header}\n${body}` : header),
  };
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

function score(candidate: string, query: string): number {
  const text = normalize(candidate);
  if (!text) return 0;
  if (text === query) return 3;
  if (text.startsWith(query)) return 2;
  return text.includes(query) ? 1 : 0;
}

export interface FindOptions {
  query: string;
  role?: string;
  limit: number;
}

/** Búsqueda determinista sobre lo que el agente vería en el snapshot; los valores sensibles no se consideran. */
export async function findInPage(tab: Tab, options: FindOptions, warnings: string[]) {
  const doc = await collectPage(tab, warnings);
  const items = buildItems({ doc, baseUrl: tab.page.url() });
  const query = normalize(options.query.trim());
  const role = options.role?.toLowerCase();
  const refFor = (item: Item) =>
    item.backendNodeId === undefined ? null : tab.refs.refFor(item.backendNodeId, item.frameKey);

  const found: { rank: number; order: number; match: Record<string, unknown> }[] = [];
  let order = 0;
  const walk = (list: Item[], parent: Item | null): void => {
    for (const item of list) {
      const rank = Math.max(score(item.name, query), score(item.value, query));
      if (rank > 0 && (!role || item.role.toLowerCase() === role)) {
        const owner = item.role === "text" ? parent : item;
        found.push({
          rank,
          order: order++,
          match: {
            ref: owner ? refFor(owner) : null,
            role: item.role,
            name: item.name.length > 160 ? `${item.name.slice(0, 160)}…` : item.name,
          },
        });
      }
      walk(item.children, item.role === "text" ? parent : item);
    }
  };
  walk(items, null);
  found.sort((a, b) => b.rank - a.rank || a.order - b.order);
  await collectInjectionWarnings(tab.page, pageText(doc), warnings);
  return { matches: found.slice(0, options.limit).map((entry) => entry.match), total: found.length };
}
