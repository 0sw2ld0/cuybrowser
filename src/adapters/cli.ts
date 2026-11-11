#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Option } from "commander";
import type { ToolResponse } from "../core/errors.js";
import { ensureHome, screenshotsDir } from "../core/paths.js";
import type { AnyTool } from "../core/registry.js";
import { toolInputSchema } from "../core/schema.js";
import { VERSION } from "../core/version.js";
import { DOC_FORMATS, generateDocs, type DocFormat } from "../docs/generate.js";
import { callTool, daemonInfo, resolveApproval, stopDaemon } from "../ipc/client.js";
import { tools } from "../tools/index.js";
import { CLIENTS, setupMcp, type Client } from "./setup.js";

interface ImageData {
  image: { mime_type: string; base64: string };
}

function hasImage(data: unknown): data is ImageData {
  return typeof data === "object" && data !== null && "image" in data;
}

function saveImage(data: ImageData, out: string | undefined): string {
  const path = out
    ? resolve(out)
    : (ensureHome(), join(screenshotsDir(), `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(data.image.base64, "base64"));
  return path;
}

function formatData(tool: AnyTool, data: unknown): string {
  if (tool.cli?.format) return tool.cli.format(data);
  if (typeof data !== "object" || data === null) return String(data);
  const record = data as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
    .join("\n");
}

function print(tool: AnyTool, response: ToolResponse, options: Record<string, unknown>): void {
  if (response.ok && hasImage(response.data) && !options.base64) {
    const path = saveImage(response.data, options.out as string | undefined);
    response = { ...response, data: { path } };
  }
  if (options.json) {
    console.log(JSON.stringify(response));
  } else if (!response.ok) {
    console.error(`Error [${response.error.code}]: ${response.error.message}`);
    if (response.error.hint) console.error(`Pista: ${response.error.hint}`);
    if (response.error.confirmation) {
      console.error(`Confirmación: cuybrowser confirm ${response.error.confirmation.confirmation_id}`);
    }
  } else {
    if (hasImage(response.data)) console.log(response.data.image.base64);
    else console.log(formatData(tool, response.data));
    for (const warning of response.warnings) console.error(`Aviso: ${warning}`);
  }
  if (!response.ok) process.exitCode = 1;
}

function addTool(program: Command, tool: AnyTool): void {
  const schema = toolInputSchema(tool);
  const properties = schema.properties ?? {};
  const positional = tool.cli?.positional ?? [];
  const command = program.command(tool.name).description(tool.description);
  const attributes = new Map<string, string>();

  for (const name of positional) command.argument(`[${name}]`, properties[name]?.description);

  for (const [name, property] of Object.entries(properties)) {
    const flag = (tool.cli?.aliases?.[name] ?? name).replace(/_/g, "-");
    const isBoolean = property.type === "boolean";
    const option = new Option(isBoolean ? `--${flag}` : `--${flag} <valor>`, property.description);
    if (property.enum) option.choices(property.enum);
    if (property.type === "number" || property.type === "integer") option.argParser(Number);
    if (property.type === "array") option.argParser((value: string) => value.split(","));
    command.addOption(option);
    attributes.set(name, option.attributeName());
    // Un booleano obligatorio necesita una forma explícita de decir que no.
    if (isBoolean && schema.required?.includes(name)) {
      command.addOption(new Option(`--no-${flag}`, `Lo contrario de --${flag}.`));
    }
  }

  const shortcuts = Object.entries(tool.cli?.shortcuts ?? {});
  for (const [flag, shortcut] of shortcuts) command.option(`--${flag}`, shortcut.description);

  command.option("--json", "Muestra la respuesta completa en JSON.");
  if (tool.cli?.returnsImage) {
    command.option("--out <ruta>", "Archivo donde se guarda la imagen.");
    command.option("--base64", "Muestra la imagen en base64 en lugar de guardarla.");
  }

  command.action(async (...args: unknown[]) => {
    const options = command.opts();
    const params: Record<string, unknown> = {};
    for (const [name, attribute] of attributes) {
      if (options[attribute] !== undefined) params[name] = options[attribute];
    }
    for (const [flag, shortcut] of shortcuts) {
      if (options[flag]) params[shortcut.param] = shortcut.value;
    }
    positional.forEach((name, index) => {
      if (args[index] !== undefined) params[name] = args[index];
    });
    print(tool, await callTool(tool.name, params), options);
  });
}

const program = new Command("cuybrowser")
  .description("Control de un navegador del motor de Chrome para agentes de IA.")
  .version(VERSION);

for (const tool of tools) addTool(program, tool);

program
  .command("mcp")
  .description("Inicia el servidor MCP por stdio.")
  .option("--prefix <prefijo>", "Prefijo de los nombres de herramienta.", "browser_")
  .action(async (options: { prefix: string }) => {
    const { runMcp } = await import("./mcp.js");
    await runMcp(tools, options.prefix);
  });

program
  .command("setup")
  .description("Detecta clientes MCP o registra CuyBrowser para el cliente elegido.")
  .addArgument(new Argument("[cliente]", "Cliente que quieres configurar.").choices([...CLIENTS]))
  .action((client: Client | undefined) => {
    process.exitCode = setupMcp(client, () => fileURLToPath(import.meta.url));
  });

program
  .command("serve")
  .description("Inicia la API HTTP local.")
  .option("--http", "Habilita la API HTTP.")
  .addOption(new Option("--port <puerto>", "Puerto local.").default(47777).argParser(Number))
  .action(async (options: { http?: boolean; port: number }) => {
    if (!options.http) {
      console.error("Indica --http para habilitar la API.");
      process.exitCode = 1;
      return;
    }
    const { runHttp } = await import("./http.js");
    await runHttp(tools, options.port);
  });

program
  .command("docs")
  .description("Genera la documentación para agentes.")
  .addOption(new Option("--format <formato>", "Formato.").choices([...DOC_FORMATS]).default("agents-md"))
  .action((options: { format: DocFormat }) => {
    process.stdout.write(generateDocs(tools, options.format));
  });

program
  .command("browsers")
  .description("Lista los navegadores compatibles instalados, en el orden en que se prueban.")
  .action(async () => {
    const { realSystem, resolveBrowsers, detectBrowsers } = await import("../core/driver/browsers.js");
    const system = await realSystem();
    const found = detectBrowsers(system);
    const choice = process.env.CUYBROWSER_BROWSER?.trim();
    let chosen: string | null = null;
    try {
      chosen = resolveBrowsers(choice, system)[0]?.executablePath ?? null;
    } catch (err) {
      console.error(`${err instanceof Error ? err.message : String(err)}`);
      const hint = (err as { hint?: string }).hint;
      if (hint) console.error(`Pista: ${hint}`);
      process.exitCode = 1;
    }
    for (const browser of found) {
      console.log(`${browser.executablePath === chosen ? "*" : " "} ${browser.name}: ${browser.executablePath}`);
    }
    if (chosen && !found.some((browser) => browser.executablePath === chosen)) console.log(`* ${chosen}`);
    if (choice) console.log(`CUYBROWSER_BROWSER=${choice}`);
  });

program
  .command("install-browser")
  .description(
    "Descarga una sola vez el Chromium de Playwright para un equipo sin ningún navegador compatible. Lo ejecuta la persona usuaria.",
  )
  .option("--yes", "No pide confirmación antes de descargar.")
  .action(async (options: { yes?: boolean }) => {
    const { installBrowser } = await import("../core/driver/install.js");
    process.exitCode = await installBrowser({ yes: options.yes === true });
  });

// Lo usa el binario compilado para lanzarse a sí mismo como daemon.
program.command("__daemon", { hidden: true }).action(async () => {
  const { runDaemon } = await import("../core/daemon.js");
  await runDaemon(tools);
});

/** Comandos para la persona usuaria; solo funcionan con approval: cli. */
function addApprovalCommand(name: string, approved: boolean, description: string): void {
  program
    .command(name)
    .description(description)
    .argument("<id>", "Id de la confirmación.")
    .action(async (id: string) => {
      const problem = await resolveApproval(id, approved, "cli").catch((err: Error) => err.message);
      if (problem) {
        console.error(problem);
        process.exitCode = 1;
      } else {
        console.log(approved ? "aprobada" : "rechazada");
      }
    });
}
addApprovalCommand("approve", true, "Aprueba una acción retenida (lo ejecuta la persona, solo con approval: cli).");
addApprovalCommand("deny", false, "Rechaza una acción retenida (lo ejecuta la persona, solo con approval: cli).");

const daemon = program.command("daemon").description("Consulta o detiene el proceso en segundo plano.");
daemon
  .command("status")
  .description("Indica si el daemon está en marcha.")
  .action(async () => {
    const info = await daemonInfo();
    console.log(
      info === null ? "detenido" : `en marcha (pid ${info.pid}, versión ${info.version ?? "desconocida"})`,
    );
  });
daemon
  .command("stop")
  .description("Detiene el daemon y cierra el navegador.")
  .action(async () => {
    console.log((await stopDaemon()) ? "detenido" : "no estaba en marcha");
  });

const { isDownloadChild, runDownloadChild } = await import("../core/driver/install.js");
if (isDownloadChild()) await runDownloadChild();
else await program.parseAsync();
