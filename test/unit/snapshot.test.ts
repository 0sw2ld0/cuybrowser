import { describe, expect, it } from "vitest";
import { classifySensitive } from "../../src/core/security/sensitive.js";
import { RefTable } from "../../src/core/snapshot/refs.js";
import {
  buildItems,
  diffLines,
  estimateTokens,
  flatten,
  renderSnapshot,
  renderWithBudget,
  type AxNode,
  type FrameDoc,
} from "../../src/core/snapshot/render.js";

function node(id: number, role: string, name: string, childIds: number[] = [], extra: Partial<AxNode> = {}): AxNode {
  return {
    nodeId: String(id),
    backendDOMNodeId: id,
    role: { value: role },
    name: { value: name },
    childIds: childIds.map(String),
    ...extra,
  };
}

function render(nodes: AxNode[], attributes: [number, Record<string, string>][] = [], interactiveOnly = false) {
  const refs = new RefTable();
  return renderSnapshot({
    doc: { frameKey: "", nodes, attributes: new Map(attributes), children: new Map() },
    refFor: (id, key) => refs.refFor(id, key),
    baseUrl: "https://example.com/login",
    interactiveOnly,
  });
}

describe("renderSnapshot", () => {
  it("sigue el formato compacto y oculta el valor de los campos sensibles", () => {
    const text = render(
      [
        node(1, "RootWebArea", "Título", [2, 3, 8]),
        node(2, "heading", "Bienvenido", [20]),
        node(20, "StaticText", "Bienvenido"),
        node(3, "form", "", [4, 5, 6]),
        node(4, "textbox", "Correo", [], { value: { value: "" } }),
        node(5, "textbox", "Contraseña", [50], { value: { value: "secreto" } }),
        node(50, "StaticText", "secreto"),
        node(6, "checkbox", "Recordarme", [], {
          properties: [{ name: "checked", value: { value: "false" } }],
        }),
        node(8, "link", "Recuperar", []),
      ],
      [
        [5, { type: "password" }],
        [8, { href: "/reset" }],
      ],
    );
    expect(text).toBe(
      [
        '- heading "Bienvenido" [e1]',
        "- form [e2]",
        '  - textbox "Correo" [e3] value=""',
        '  - textbox "Contraseña" [e4] (password, SENSIBLE)',
        '  - checkbox "Recordarme" [e5] checked=false',
        '- link "Recuperar" [e6] → /reset',
      ].join("\n"),
    );
    expect(text).not.toContain("secreto");
  });

  it("omite contenedores vacíos, decorativos e ignorados, y los nodos genéricos no generan niveles", () => {
    const text = render([
      node(1, "RootWebArea", "", [2, 3, 4, 5]),
      node(2, "generic", "", [6]),
      node(6, "button", "Dentro", []),
      node(3, "group", "", []),
      node(4, "image", "", []),
      node(5, "button", "Oculto", [], { ignored: true }),
    ]);
    expect(text).toBe('- button "Dentro" [e1]');
  });

  it("une textos contiguos y quita la etiqueta repetida", () => {
    const text = render([
      node(1, "RootWebArea", "", [2, 3, 4, 5]),
      node(2, "StaticText", "Hola"),
      node(3, "StaticText", "mundo"),
      node(4, "StaticText", "Correo"),
      node(5, "textbox", "Correo", []),
    ]);
    expect(text).toBe('- text "Hola mundo Correo"\n- textbox "Correo" [e1] value=""');
  });

  it("escapa comillas y saltos de línea para que la página no pueda falsear líneas", () => {
    const text = render([
      node(1, "RootWebArea", "", [2]),
      node(2, "button", 'Malo"\n- button "Falso" [e99]', []),
    ]);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain('\\"Falso\\"');
  });

  it("interactive_only conserva solo los controles", () => {
    const text = render(
      [
        node(1, "RootWebArea", "", [2, 3]),
        node(2, "heading", "Título", []),
        node(3, "form", "", [4, 5]),
        node(4, "StaticText", "Texto"),
        node(5, "button", "Enviar", []),
      ],
      [],
      true,
    );
    expect(text).toBe('- button "Enviar" [e1]');
  });
});

function docOf(nodes: AxNode[], children: [number, FrameDoc][] = [], frameKey = ""): FrameDoc {
  return { frameKey, nodes, attributes: new Map(), children: new Map(children) };
}

describe("compactación", () => {
  it("quita la estructura sin nombre y conserva las listas largas con una ref", () => {
    const shortList = render([
      node(1, "RootWebArea", "", [2]),
      node(2, "list", "", [3]),
      node(3, "listitem", "", [4]),
      node(4, "link", "Uno", []),
    ]);
    expect(shortList).toBe('- link "Uno" [e1]');

    const ids = [10, 11, 12, 13, 14];
    const longList = render([
      node(1, "RootWebArea", "", [2]),
      node(2, "list", "", ids),
      ...ids.map((id) => node(id, "link", `L${id}`, [])),
    ]);
    expect(longList.split("\n")[0]).toBe("- list [e1]");
  });

  it("recorta los textos largos sin partir líneas", () => {
    const text = render([node(1, "RootWebArea", "", [2]), node(2, "StaticText", "x".repeat(500))]);
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("…");
  });

  it("no une textos si la línea resultante sería demasiado larga", () => {
    const text = render([
      node(1, "RootWebArea", "", [2, 3]),
      node(2, "StaticText", "a".repeat(100)),
      node(3, "StaticText", "b".repeat(100)),
    ]);
    expect(text.split("\n")).toHaveLength(2);
  });
});

describe("presupuesto de tokens", () => {
  const refs = () => {
    const table = new RefTable();
    return { refFor: (id: number, key: string) => table.refFor(id, key) };
  };
  const big = (count: number) => {
    const ids = Array.from({ length: count }, (_, i) => i + 10);
    return buildItems({
      doc: docOf([
        node(1, "RootWebArea", "", [2]),
        node(2, "list", "", ids),
        ...ids.map((id) => node(id, "link", `Elemento número ${id}`, [])),
      ]),
      baseUrl: "https://example.com/",
    });
  };

  it("no recorta si cabe", () => {
    expect(renderWithBudget(big(5), refs(), 8000).truncated).toBe(false);
  });

  it("recorta las listas largas e indica cómo ver el resto", () => {
    const { text, truncated } = renderWithBudget(big(2000), refs(), 1000);
    expect(truncated).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/… \(\d+ elementos más, usa scope_ref=e\d+\)/);
  });

  it("corta el final si ni siquiera el recorte de listas basta", () => {
    const { text, truncated } = renderWithBudget(big(50), refs(), 10);
    expect(truncated).toBe(true);
    expect(text).toContain("contenido recortado");
  });
});

describe("diff", () => {
  it("marca lo añadido, eliminado y modificado", () => {
    const refOptions = { refFor: (id: number) => `e${id}` };
    const lines = (nodes: AxNode[]) =>
      flatten(buildItems({ doc: docOf(nodes), baseUrl: "https://example.com/" }), refOptions);
    const before = lines([
      node(1, "RootWebArea", "", [2, 3, 4]),
      node(2, "button", "Igual", []),
      node(3, "button", "Se va", []),
      node(4, "textbox", "Campo", [], { value: { value: "a" } }),
    ]);
    const after = lines([
      node(1, "RootWebArea", "", [2, 4, 5]),
      node(2, "button", "Igual", []),
      node(4, "textbox", "Campo", [], { value: { value: "b" } }),
      node(5, "button", "Nuevo", []),
    ]);
    expect(diffLines(before, after)).toEqual([
      '~ textbox "Campo" [e4] value="b"',
      '+ button "Nuevo" [e5]',
      '- button "Se va" [e3]',
    ]);
    expect(diffLines(after, after)).toEqual([]);
  });
});

describe("iframes", () => {
  it("anida el contenido y usa el prefijo del frame en las refs", () => {
    const child = docOf([node(1, "RootWebArea", "", [2]), node(2, "button", "Dentro", [])], [], "f1");
    const refs = new RefTable();
    const text = renderSnapshot({
      doc: docOf([node(1, "RootWebArea", "", [5]), node(5, "Iframe", "Pago", [])], [[5, child]]),
      refFor: (id, key) => refs.refFor(id, key),
      baseUrl: "https://example.com/",
    });
    expect(text).toBe('- iframe "Pago" [e1]\n  - button "Dentro" [f1e2]');
    expect(refs.resolve("f1e2").frameKey).toBe("f1");
  });

  it("invalida solo las refs del frame que navega", () => {
    const refs = new RefTable();
    const main = refs.refFor(1);
    const inner = refs.refFor(1, "f1");
    refs.invalidate("f1");
    expect(refs.resolve(main).backendNodeId).toBe(1);
    expect(() => refs.resolve(inner)).toThrow(expect.objectContaining({ code: "REF_STALE" }));
  });
});

describe("RefTable", () => {
  it("mantiene la ref de un nodo y distingue una ref antigua de una desconocida", () => {
    const refs = new RefTable();
    const ref = refs.refFor(10);
    expect(refs.refFor(10)).toBe(ref);
    expect(refs.resolve(ref).backendNodeId).toBe(10);
    expect(() => refs.resolve("e99")).toThrow(expect.objectContaining({ code: "REF_NOT_FOUND" }));
    refs.invalidate();
    expect(() => refs.resolve(ref)).toThrow(expect.objectContaining({ code: "REF_STALE" }));
    expect(refs.refFor(10)).not.toBe(ref);
  });
});

describe("classifySensitive", () => {
  it.each([
    [{ type: "password" }, "password"],
    [{ autocomplete: "current-password" }, "password"],
    [{ autocomplete: "cc-number" }, "tarjeta"],
    [{ autocomplete: "cc-csc" }, "cvv"],
    [{ name: "card_number" }, "tarjeta"],
    [{ id: "cvv" }, "cvv"],
    [{ autocomplete: "one-time-code" }, "código"],
  ])("clasifica %j", (attrs, expected) => {
    expect(classifySensitive(attrs as Record<string, string>)).toBe(expected);
  });

  it.each([[{ type: "email", name: "email" }], [{ name: "discard" }], [{ id: "scvvy" }]])(
    "no marca %j",
    (attrs) => {
      expect(classifySensitive(attrs as Record<string, string>)).toBeNull();
    },
  );
});
