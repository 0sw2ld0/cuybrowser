import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/core/version.js";
import { generateDocs } from "../../src/docs/generate.js";
import { tools } from "../../src/tools/index.js";

describe("distribución", () => {
  it("la versión del código coincide con la del paquete", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("documentación generada", () => {
  it("docs/AGENTS.md coincide con el registro de herramientas", () => {
    const committed = readFileSync(new URL("../../docs/AGENTS.md", import.meta.url), "utf8");
    expect(committed, "Ejecuta npm run docs para actualizarlo").toBe(generateDocs(tools, "agents-md"));
  });

  it("documenta todas las herramientas en cada formato", () => {
    for (const format of ["agents-md", "skill-md", "markdown"] as const) {
      const doc = generateDocs(tools, format);
      for (const tool of tools) expect(doc).toContain(`### ${tool.name}\n`);
    }
    expect(generateDocs(tools, "skill-md").startsWith("---\nname: cuybrowser\n")).toBe(true);
  });
});
