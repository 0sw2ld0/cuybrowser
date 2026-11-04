import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";
import { resolveElement } from "../core/element.js";
import { CuyError } from "../core/errors.js";
import { homeDir } from "../core/paths.js";
import { defineTool } from "../core/registry.js";
import { pageHost, quotePageText } from "../core/security/classify.js";

function protectedDirs(): string[] {
  const home = homedir();
  return [homeDir(), ...[".ssh", ".gnupg", ".aws", ".kube", ".config/gcloud"].map((dir) => join(home, dir))].map(
    (dir) => {
      try {
        return realpathSync(dir);
      } catch {
        return resolve(dir);
      }
    },
  );
}

/** Se resuelven los enlaces simbólicos para que uno no pueda apuntar a una carpeta protegida. */
function checkPaths(paths: string[]): string[] {
  const blocked = protectedDirs();
  return paths.map((path) => {
    let real: string;
    try {
      real = realpathSync(resolve(path));
      if (!statSync(real).isFile()) throw new Error("not_file");
    } catch {
      throw new CuyError("INVALID_PARAMS", `El archivo no existe o no es un archivo: ${path}`);
    }
    if (blocked.some((dir) => real === dir || real.startsWith(`${dir}${sep}`))) {
      throw new CuyError("BLOCKED_BY_POLICY", `No se permite subir archivos de esa carpeta: ${path}`);
    }
    return real;
  });
}

export default defineTool({
  name: "upload_file",
  description: "Adjunta archivos locales a un campo de tipo archivo.",
  params: z.strictObject({
    ref: z.string().describe("Ref del campo de archivo."),
    paths: z.array(z.string()).min(1).describe("Rutas de los archivos, separadas por comas en el CLI."),
  }),
  risk: "sensitive",
  cli: { positional: ["ref"] },
  gate: async ({ session }, { paths }) => {
    const names = checkPaths(paths).map((path) => quotePageText(basename(path)));
    return {
      kinds: ["file_upload"],
      description: `Subir ${names.join(", ")} a ${pageHost(session.activeTab())}.`,
    };
  },
  handler: async ({ session }, { ref, paths }) => {
    const files = checkPaths(paths);
    const tab = session.activeTab();
    const element = await resolveElement(tab, ref);
    try {
      const isFileInput = await element.call<boolean>(
        "function(){return this.tagName==='INPUT'&&this.type==='file'&&!this.disabled}",
      );
      if (!isFileInput) throw element.notInteractable("no es un campo de archivo");
      const cdp = await tab.cdp();
      await cdp.send("DOM.setFileInputFiles", { files, backendNodeId: element.backendNodeId });
      await element.call("function(){this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}))}");
      return { uploaded: files.length };
    } finally {
      await element.dispose();
    }
  },
});
