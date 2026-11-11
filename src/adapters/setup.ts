import { spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from "jsonc-parser";
import { isExecutable, isStandalone } from "../core/runtime.js";

export const CLIENTS = ["claude-code", "cursor", "codex"] as const;
export type Client = (typeof CLIENTS)[number];

const NAMES: Record<Client, string> = { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex" };
const SERVER_NAME = "cuybrowser";

interface Launch {
  command: string;
  args: string[];
}

interface ConfigFile {
  bytes: Buffer;
  mode: number;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function findOnPath(...names: string[]): string | undefined {
  const extensions = process.platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const rawDirectory of (process.env.PATH ?? "").split(delimiter)) {
    const directory = rawDirectory.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(directory)) continue;
    for (const name of names) {
      for (const suffix of extensions) {
        const path = join(directory, name + suffix);
        if (isExecutable(path)) return path;
      }
    }
  }
}

function codexCommand(): Launch | undefined {
  const command = findOnPath("codex");
  if (!command) return;
  if (process.platform === "win32" && command.toLowerCase().endsWith(".cmd")) {
    // El shim de npm requiere cmd.exe. Ejecutamos la entrada de Codex directamente con Node.
    const entry = join(dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
    const node = isStandalone ? findOnPath("node") : process.execPath;
    if (node && existsSync(entry)) return { command: node, args: [entry] };
    return;
  }
  return { command, args: [] };
}

function configPaths(home: string): Record<Client, string> {
  return {
    "claude-code": resolve(process.env.CLAUDE_CONFIG_DIR || home, ".claude.json"),
    cursor: join(home, ".cursor", "mcp.json"),
    codex: resolve(process.env.CODEX_HOME || join(home, ".codex"), "config.toml"),
  };
}

function listClients(home: string, paths: Record<Client, string>): void {
  const detected: Record<Client, boolean> = {
    "claude-code": Boolean(findOnPath("claude")) || existsSync(paths["claude-code"]) ||
      existsSync(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude")),
    cursor: Boolean(findOnPath("cursor", "cursor-agent")) || existsSync(dirname(paths.cursor)) ||
      (process.platform === "darwin" && ["/Applications", join(home, "Applications")].some(
        (directory) => existsSync(join(directory, "Cursor.app")),
      )) ||
      (process.platform === "win32" && isExecutable(join(
        process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "Cursor", "Cursor.exe",
      ))),
    codex: Boolean(findOnPath("codex")) || existsSync(paths.codex),
  };
  for (const client of CLIENTS) {
    console.log(`${NAMES[client]} (${client}): ${detected[client] ? "detectado" : "no detectado"}`);
  }
  console.log("Para registrar CuyBrowser en un cliente, ejecuta cuybrowser setup <cliente>.");
}

function readConfig(path: string): ConfigFile | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new Error("La configuración debe ser un archivo regular, no un enlace.");
    return { bytes: readFileSync(path), mode: info.mode & 0o777 };
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
}

function locked<T>(path: string, action: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.cuybrowser-setup.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (code(error) === "EEXIST") throw new Error("El registro está ocupado por otra ejecución de setup. Intenta de nuevo.");
    throw error;
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lock, { force: true });
  }
}

function writeConfig(path: string, content: string, original: ConfigFile | undefined): void {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".cuybrowser-setup-"));
  try {
    const temporaryFile = join(temporaryDirectory, "config.json");
    writeFileSync(temporaryFile, content, { mode: 0o600 });
    if (original) chmodSync(temporaryFile, original.mode);
    const latest = readConfig(path);
    if (latest?.mode !== original?.mode || (latest && original && !latest.bytes.equals(original.bytes))) {
      throw new Error("La configuración cambió durante setup. Ejecuta el comando de nuevo.");
    }
    renameSync(temporaryFile, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function uniqueProperty(node: Node | undefined, name: string): Node | undefined {
  const matches = node?.children?.filter((property) => property.children?.[0]?.value === name) ?? [];
  if (matches.length > 1) throw new Error(`Hay más de una entrada ${name} en la configuración.`);
  return matches[0]?.children?.[1];
}

function sameLaunch(value: unknown, launch: Launch): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const { type, command, args } = record;
  return (type === undefined || type === "stdio") && command === launch.command &&
    Array.isArray(args) && args.length === launch.args.length &&
    args.every((arg, index) => arg === launch.args[index]);
}

function existingRegistration(value: unknown, launch: Launch): false {
  if (!sameLaunch(value, launch)) {
    throw new Error("Ya existe un servidor MCP cuybrowser con otra configuración. Revisa esa entrada antes de volver a ejecutar setup.");
  }
  return false;
}

function registerJson(path: string, launch: Launch, client: "claude-code" | "cursor"): boolean {
  const original = readConfig(path);
  const decoded = original ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original.bytes) : "{}\n";
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = decoded.slice(bom.length);
  const errors: ParseError[] = [];
  const isCursor = client === "cursor";
  const root = parseTree(text, errors, { allowTrailingComma: isCursor, disallowComments: !isCursor });
  if (errors.length || root?.type !== "object") {
    throw new Error("La configuración MCP debe ser un objeto JSON válido.");
  }
  const servers = uniqueProperty(root, "mcpServers");
  if (servers && servers.type !== "object") throw new Error("El campo mcpServers debe ser un objeto.");
  const existing = uniqueProperty(servers, SERVER_NAME);
  if (existing) return existingRegistration(getNodeValue(existing), launch);

  const entry = client === "claude-code" ? { type: "stdio", ...launch } : launch;
  const edits = modify(text, ["mcpServers", SERVER_NAME], entry, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  });
  locked(path, () => writeConfig(path, bom + applyEdits(text, edits), original));
  return true;
}

function registerCodex(path: string, home: string, launch: Launch): boolean {
  const codex = codexCommand();
  if (!codex) throw new Error("Para configurar Codex, su CLI debe estar disponible en PATH.");
  return locked(path, () => {
    const run = (...args: string[]) => spawnSync(codex.command, [...codex.args, "mcp", ...args], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: dirname(path) },
      encoding: "utf-8",
      timeout: 20_000,
      windowsHide: true,
    });
    const current = run("get", "--json", SERVER_NAME);
    if (current.status === 0) {
      let entry: { name?: string; transport?: unknown } | null;
      try {
        entry = JSON.parse(current.stdout);
      } catch {
        throw new Error("Codex devolvió una configuración MCP que setup no puede leer.");
      }
      if (entry?.name !== SERVER_NAME) throw new Error("Codex no devolvió la entrada MCP solicitada.");
      return existingRegistration(entry.transport, launch);
    }
    // No mostramos la salida de Codex: podría contener valores de configuración.
    if (current.status !== 1 || !current.stderr.includes(`No MCP server named '${SERVER_NAME}' found.`)) {
      throw new Error("Codex no pudo consultar el registro MCP del usuario. Revisa su configuración y la versión de la CLI.");
    }
    const result = run("add", SERVER_NAME, "--", launch.command, ...launch.args);
    if (result.status !== 0) throw new Error("Codex no pudo añadir el servidor MCP. Revisa su configuración.");
    return true;
  });
}

export function setupMcp(client: Client | undefined, cliModule: () => string): number {
  const home = homedir();
  const paths = configPaths(home);
  if (!client) {
    listClients(home, paths);
    return 0;
  }
  const launch = { command: process.execPath, args: isStandalone ? ["mcp"] : [cliModule(), "mcp"] };
  try {
    const added = client === "codex" ? registerCodex(paths.codex, home, launch) : registerJson(paths[client], launch, client);
    console.log(`${NAMES[client]}: ${added ? "CuyBrowser añadido al registro MCP del usuario. Vuelve a abrir el cliente." : "CuyBrowser ya está registrado."}`);
    return 0;
  } catch (error) {
    console.error(`${NAMES[client]}: ${error instanceof Error ? error.message : "No se pudo actualizar la configuración MCP."}`);
    return 1;
  }
}
