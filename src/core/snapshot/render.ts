import { classifySensitive } from "../security/sensitive.js";

export interface AxValue {
  value?: unknown;
}

export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: { name: string; value: AxValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export interface FrameDoc {
  frameKey: string;
  nodes: AxNode[];
  attributes: Map<number, Record<string, string>>;
  /** Documentos de los iframes, por el backendNodeId de su elemento. */
  children: Map<number, FrameDoc>;
}

export interface BuildOptions {
  doc: FrameDoc;
  baseUrl: string;
  scope?: { frameKey: string; backendNodeId: number };
  interactiveOnly?: boolean;
}

export interface Item {
  role: string;
  name: string;
  /** Valor buscable. Nunca se rellena en campos sensibles. */
  value: string;
  frameKey: string;
  backendNodeId?: number;
  details: string;
  children: Item[];
}

export interface RenderOptions {
  refFor: (backendNodeId: number, frameKey: string) => string;
}

export interface FlatLine {
  key: string;
  text: string;
}

const TEXT = "text";
const NAME_LIMIT = 160;
const HREF_LIMIT = 80;
const DROPPED = new Set(["InlineTextBox", "ListMarker", "LineBreak"]);
const HOISTED = new Set(["generic", "none", "presentation", "RootWebArea", "LabelText", "MenuListPopup"]);
/** Sin nombre propio solo aportan estructura visual y gastan tokens. */
const STRUCTURAL = new Set([
  "paragraph",
  "listitem",
  "group",
  "Section",
  "section",
  "blockquote",
  "DescriptionList",
  "DescriptionListTerm",
  "DescriptionListDetail",
  "term",
  "definition",
  "strong",
  "emphasis",
  "time",
  "code",
  "mark",
  "subscript",
  "superscript",
  "Abbr",
  "deletion",
  "insertion",
  "legend",
  "caption",
  "figure",
  "Figcaption",
  "Pre",
  "note",
  "rowgroup",
  "cell",
  "gridcell",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
]);
/** Una lista corta no necesita una ref propia; una larga sí, para poder pedirla con scope_ref. */
const LIST_REF_THRESHOLD = 5;
const DECORATIVE_WITHOUT_NAME = new Set(["image", "img", "separator"]);
const LEAVES = new Set([
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "image",
  "img",
]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "slider",
  "spinbutton",
  "listbox",
  "option",
  "treeitem",
]);

export const ATTRIBUTE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "link"]);
export const IFRAME_ROLES = new Set(["Iframe", "IframePresentational"]);

function clean(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/\s+/g, " ").trim()
    : "";
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function displayHref(href: string, baseUrl: string): string {
  try {
    const target = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    const shown =
      target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` : target.href;
    return shorten(shown, HREF_LIMIT);
  } catch {
    return shorten(href, HREF_LIMIT);
  }
}

function isText(item: Item): boolean {
  return item.role === TEXT;
}

/** Une textos contiguos sin crear líneas enormes y quita el texto que repite el nombre del control vecino. */
function tidy(items: Item[]): Item[] {
  const merged: Item[] = [];
  for (const item of items) {
    const previous = merged[merged.length - 1];
    if (previous && isText(item) && isText(previous) && previous.name.length + item.name.length < NAME_LIMIT) {
      previous.name = `${previous.name} ${item.name}`;
    } else {
      merged.push(item);
    }
  }
  return merged.filter((item, index) => {
    if (!isText(item)) return true;
    const before = merged[index - 1];
    const after = merged[index + 1];
    return !(
      (before && !isText(before) && before.name === item.name) ||
      (after && !isText(after) && after.name === item.name)
    );
  });
}

function findDoc(doc: FrameDoc, frameKey: string): FrameDoc | null {
  if (doc.frameKey === frameKey) return doc;
  for (const child of doc.children.values()) {
    const found = findDoc(child, frameKey);
    if (found) return found;
  }
  return null;
}

export function buildItems(options: BuildOptions): Item[] {
  const visitDoc = (doc: FrameDoc, startNode?: AxNode): Item[] => {
    const byId = new Map(doc.nodes.map((node) => [node.nodeId, node]));

    const describe = (node: AxNode, role: string): { details: string; value: string } => {
      const details: string[] = [];
      let value = "";
      const attrs =
        node.backendDOMNodeId === undefined ? undefined : doc.attributes.get(node.backendDOMNodeId);
      const sensitive = attrs && role !== "link" ? classifySensitive(attrs) : null;

      if (sensitive) {
        details.push(`(${sensitive}, SENSIBLE)`);
      } else if (VALUE_ROLES.has(role)) {
        value = clean(node.value?.value);
        details.push(`value=${quote(shorten(value, NAME_LIMIT))}`);
      }

      const property = (name: string): unknown =>
        node.properties?.find((candidate) => candidate.name === name)?.value?.value;

      if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
        details.push(`checked=${String(property("checked") ?? false)}`);
      }
      for (const name of ["pressed", "expanded"]) {
        const current = property(name);
        if (current !== undefined) details.push(`${name}=${String(current)}`);
      }
      for (const name of ["selected", "disabled", "required"]) {
        if (property(name) === true) details.push(name);
      }
      if (role === "link" && attrs?.href) details.push(`→ ${displayHref(attrs.href, options.baseUrl)}`);
      return { details: details.join(" "), value };
    };

    const visitChildren = (node: AxNode, context: string): Item[] =>
      (node.childIds ?? []).flatMap((id) => {
        const child = byId.get(id);
        return child ? visit(child, context) : [];
      });

    const visit = (node: AxNode, context: string): Item[] => {
      if (node.ignored) return visitChildren(node, context);
      const role = clean(node.role?.value);
      if (DROPPED.has(role)) return [];
      const name = clean(node.name?.value);

      if (IFRAME_ROLES.has(role)) {
        const child = node.backendDOMNodeId === undefined ? undefined : doc.children.get(node.backendDOMNodeId);
        const children = child ? tidy(visitDoc(child)) : [];
        if (children.length === 0) return [];
        return [
          {
            role: "iframe",
            name,
            value: "",
            frameKey: doc.frameKey,
            ...(node.backendDOMNodeId === undefined ? {} : { backendNodeId: node.backendDOMNodeId }),
            details: "",
            children,
          },
        ];
      }
      if (role === "StaticText") {
        if (options.interactiveOnly || !name || context.includes(name)) return [];
        return [{ role: TEXT, name, value: "", frameKey: doc.frameKey, details: "", children: [] }];
      }
      if (HOISTED.has(role)) return visitChildren(node, context);
      if (options.interactiveOnly && !INTERACTIVE.has(role)) return visitChildren(node, context);
      if (DECORATIVE_WITHOUT_NAME.has(role) && (!name || context.includes(name))) return [];

      const childContext = `${context} ${name} ${clean(node.value?.value)}`;
      const children = LEAVES.has(role) ? [] : tidy(visitChildren(node, childContext));
      const interactive = INTERACTIVE.has(role);
      if (!name && !interactive) {
        if (children.length === 0) return [];
        if (STRUCTURAL.has(role)) return children;
        if (role === "list" && children.length < LIST_REF_THRESHOLD) return children;
      }

      const onlyChild = children.length === 1 ? children[0] : undefined;
      const backend = node.backendDOMNodeId === undefined ? {} : { backendNodeId: node.backendDOMNodeId };
      if (!name && !interactive && onlyChild && isText(onlyChild)) {
        return [{ role, name: onlyChild.name, value: "", frameKey: doc.frameKey, ...backend, details: "", children: [] }];
      }
      return [{ role, name, frameKey: doc.frameKey, ...backend, ...describe(node, role), children }];
    };

    const root = startNode ?? doc.nodes.find((node) => !node.parentId);
    return root ? visit(root, "") : [];
  };

  if (options.scope) {
    const { frameKey, backendNodeId } = options.scope;
    const doc = findDoc(options.doc, frameKey);
    const node = doc?.nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId);
    return doc && node ? tidy(visitDoc(doc, node)) : [];
  }
  return tidy(visitDoc(options.doc));
}

function lineFor(item: Item, options: RenderOptions): string {
  const parts = [item.role];
  if (item.name) parts.push(quote(shorten(item.name, NAME_LIMIT)));
  if (item.role !== TEXT && item.backendNodeId !== undefined) {
    parts.push(`[${options.refFor(item.backendNodeId, item.frameKey)}]`);
  }
  if (item.details) parts.push(item.details);
  return parts.join(" ");
}

function write(items: Item[], options: RenderOptions, siblingLimit: number): string[] {
  const lines: string[] = [];
  const walk = (list: Item[], depth: number, parent: Item | null): void => {
    const indent = "  ".repeat(depth);
    for (const item of list.slice(0, siblingLimit)) {
      lines.push(`${indent}- ${lineFor(item, options)}`);
      walk(item.children, depth + 1, item);
    }
    const hidden = list.length - siblingLimit;
    if (hidden > 0) {
      const scope =
        parent?.backendNodeId !== undefined
          ? `usa scope_ref=${options.refFor(parent.backendNodeId, parent.frameKey)}`
          : "usa find o scope_ref sobre una sección";
      lines.push(`${indent}… (${hidden} elementos más, ${scope})`);
    }
  };
  walk(items, 0, null);
  return lines;
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function longestList(items: Item[]): number {
  return items.reduce((longest, item) => Math.max(longest, longestList(item.children)), items.length);
}

/** Corta por el final para no pasar del límite. */
export function cutLines(lines: string[], maxTokens: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += estimateTokens(`${line}\n`);
    if (used > maxTokens) break;
    kept.push(line);
  }
  kept.push("… (contenido recortado, usa find o scope_ref)");
  return kept;
}

/** Busca cuántos elementos por lista caben para aprovechar el límite; si ninguno cabe, corta el final. */
export function renderWithBudget(
  items: Item[],
  options: RenderOptions,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const render = (limit: number) => write(items, options, limit).join("\n");
  const fits = (text: string) => estimateTokens(text) <= maxTokens;
  const complete = render(Infinity);
  if (fits(complete)) return { text: complete, truncated: false };

  let low = 1;
  let high = longestList(items) - 1;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = render(middle);
    if (fits(text)) {
      best = text;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== null) return { text: best, truncated: true };
  return { text: cutLines(write(items, options, 1), maxTokens).join("\n"), truncated: true };
}

/** Todas las líneas sin recortar, sin sangría y con una clave estable para comparar snapshots. */
export function flatten(items: Item[], options: RenderOptions): FlatLine[] {
  const lines: FlatLine[] = [];
  const walk = (list: Item[]): void => {
    for (const item of list) {
      const text = lineFor(item, options);
      const key =
        item.role !== TEXT && item.backendNodeId !== undefined
          ? options.refFor(item.backendNodeId, item.frameKey)
          : `${item.role}:${item.name}`;
      lines.push({ key, text });
      walk(item.children);
    }
  };
  walk(items);
  return lines;
}

export function diffLines(previous: FlatLine[], current: FlatLine[]): string[] {
  const before = new Map(previous.map((line) => [line.key, line.text]));
  const now = new Set(current.map((line) => line.key));
  const output: string[] = [];
  for (const { key, text } of current) {
    const old = before.get(key);
    if (old === undefined) output.push(`+ ${text}`);
    else if (old !== text) output.push(`~ ${text}`);
  }
  for (const { key, text } of previous) {
    if (!now.has(key)) output.push(`- ${text}`);
  }
  return output;
}

/** Versión sin límite de tokens. */
export function renderSnapshot(options: BuildOptions & RenderOptions): string {
  return write(buildItems(options), options, Infinity).join("\n");
}
