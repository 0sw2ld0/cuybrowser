// Se ejecuta con Bun. Sólo el build autónomo transforma estos imports; Node conserva su paquete original.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const [outfile, target] = process.argv.slice(2);
if (!outfile) throw new Error("Falta la ruta del ejecutable.");

const transformed = new Set();
const playwrightMetadata = {
  name: "metadatos-playwright-autonomo",
  setup(build) {
    build.onLoad({ filter: /[\\/]playwright-core[\\/]lib[\\/](coreBundle|serverRegistry|package)\.js$/ },
      async ({ path }) => {
        let contents = await readFile(path, "utf8");
        const module = basename(path);
        // Bun puede incluir imports literales, pero no el require de una ruta calculada con __dirname.
        for (const name of module === "coreBundle.js" ? ["package", "browsers"] : ["package"]) {
          const computed = new RegExp(String.raw`require\(import_path\d*\.default\.join\(packageRoot, "${name}\.json"\)\)`, "g");
          if ([...contents.matchAll(computed)].length !== 1) {
            throw new Error(`Cambió la carga de ${name}.json en Playwright (${module}); revisa el build autónomo.`);
          }
          contents = contents.replace(computed, `require("../${name}.json")`);
        }
        transformed.add(module);
        return { contents, loader: "js" };
      });
  },
};

const result = await Bun.build({
  entrypoints: ["./src/adapters/cli.ts"],
  compile: { outfile, ...(target ? { target } : {}) },
  define: { __CUYBROWSER_AUTONOMO__: "true" },
  // BiDi sólo hace falta en otros navegadores; CuyBrowser controla Chromium por CDP.
  external: ["chromium-bidi/*"],
  plugins: [playwrightMetadata],
});
if (!result.success || !transformed.has("coreBundle.js")) {
  throw new Error("No se pudo compilar el ejecutable con los metadatos de Playwright incluidos.");
}
