import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../dist/adapters/cli.js", import.meta.url));
const launch = { command: process.execPath, args: [cli, "mcp"] };
let root: string;
let home: string;
let bin: string;
let claude: string;
let cursor: string;
let codex: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cb-setup-"));
  home = join(root, "casa de prueba");
  bin = join(root, "bin de prueba");
  claude = join(root, "claude", ".claude.json");
  cursor = join(home, ".cursor", "mcp.json");
  codex = join(root, "codex", "config.toml");
  mkdirSync(home);
  mkdirSync(bin);
  env = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PATH: [bin, dirname(process.execPath)].join(delimiter),
    CLAUDE_CONFIG_DIR: dirname(claude),
    CODEX_HOME: dirname(codex),
    CUYBROWSER_HOME: join(root, "cuybrowser"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function setup(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "setup", ...args], { cwd: home, env, encoding: "utf-8" });
  expect(existsSync(env.CUYBROWSER_HOME!)).toBe(false);
  return result;
}

/** Representa la CLI, sin depender de que esté instalada en la máquina de CI. */
function fakeCodex(): void {
  const command = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  const entry = process.platform === "win32"
    ? join(bin, "node_modules", "@openai", "codex", "bin", "codex.js")
    : command;
  if (entry !== command) write(command, "@exit /b 99\r\n");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [category, action, ...args] = process.argv.slice(2);
const config = path.join(process.env.CODEX_HOME, "config.toml");
const state = JSON.parse(fs.readFileSync(config, "utf8"));
if (category !== "mcp" || fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.HOME)) process.exit(2);
if (action === "get" && args.join(" ") === "--json cuybrowser") {
  if (state.cuybrowser) console.log(JSON.stringify({ name: "cuybrowser", transport: state.cuybrowser }));
  else {
    console.error("Error: No MCP server named 'cuybrowser' found.");
    process.exitCode = 1;
  }
} else if (action === "add" && args[0] === "cuybrowser" && args[1] === "--") {
  if (state.cuybrowser) process.exit(3);
  state.cuybrowser = { type: "stdio", command: args[2], args: args.slice(3) };
  fs.writeFileSync(config, JSON.stringify(state));
} else process.exit(4);
`, { mode: 0o700 });
}

describe("cuybrowser setup", () => {
  it("lista los clientes detectados sin abrirlos ni escribir configuraciones", () => {
    write(claude, "configuración ficticia que no debe leerse");
    write(cursor, "configuración ficticia que no debe leerse");
    fakeCodex();
    const result = setup();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Claude Code (claude-code): detectado");
    expect(result.stdout).toContain("Cursor (cursor): detectado");
    expect(result.stdout).toContain("Codex (codex): detectado");
    expect(readFileSync(claude, "utf8")).toBe("configuración ficticia que no debe leerse");
    expect(readFileSync(cursor, "utf8")).toBe("configuración ficticia que no debe leerse");
    expect(existsSync(codex)).toBe(false);
  });

  it("registra Claude Code en el directorio elegido y conserva otros servidores y sesiones ficticias", () => {
    const original = {
      projects: { "/ficticio": { lastSessionId: "de-prueba" } },
      mcpServers: { otro: { command: "mcp-de-prueba", args: ["--test"] } },
    };
    write(claude, JSON.stringify(original, null, 2) + "\n");
    write(cursor, "{}\n");
    const result = setup("claude-code");
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(claude, "utf8");
    expect(JSON.parse(written)).toEqual({
      ...original,
      mcpServers: { ...original.mcpServers, cuybrowser: { type: "stdio", ...launch } },
    });
    expect(readFileSync(cursor, "utf8")).toBe("{}\n");
    expect(existsSync(codex)).toBe(false);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(setup("claude-code").stdout).toContain("ya está registrado");
    expect(readFileSync(claude, "utf8")).toBe(written);
  });

  it("crea el registro de usuario por defecto de Claude Code", () => {
    delete env.CLAUDE_CONFIG_DIR;
    const result = setup("claude-code");
    expect(result.status, result.stderr).toBe(0);
    const path = join(home, ".claude.json");
    expect(JSON.parse(readFileSync(path, "utf8")).mcpServers.cuybrowser).toEqual({ type: "stdio", ...launch });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("añade Cursor conservando comentarios, comas finales y otros registros", () => {
    const original = '{\r\n  // Ficticio\r\n  "mcpServers": {\r\n    "otro": { "command": "mcp-de-prueba" },\r\n  },\r\n}\r\n';
    write(cursor, original);
    const result = setup("cursor");
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(cursor, "utf8");
    expect(written).toContain("// Ficticio\r\n");
    expect(parse(written, undefined, { allowTrailingComma: true })).toEqual({
      mcpServers: { otro: { command: "mcp-de-prueba" }, cuybrowser: launch },
    });
    expect(setup("cursor").stdout).toContain("ya está registrado");
    expect(readFileSync(cursor, "utf8")).toBe(written);
    expect(existsSync(claude)).toBe(false);
  });

  it.each([
    '{"mcpServers": {"cuybrowser": {"command": "personalizado", "args": ["mcp"]}}}',
    '{"mcpServers": []}',
    '{"mcpServers": {}, "mcpServers": {}}',
    '{"mcpServers": {',
  ])("conserva la configuración incompatible (%s)", (original) => {
    write(cursor, original);
    expect(setup("cursor").status).toBe(1);
    expect(readFileSync(cursor, "utf8")).toBe(original);
  });

  it("delega el registro global de Codex a su CLI sin sobreescribir un servidor existente", () => {
    fakeCodex();
    write(codex, JSON.stringify({ otro: { command: "mcp-de-prueba" } }));
    const result = setup("codex");
    expect(result.status, result.stderr).toBe(0);
    const written = readFileSync(codex, "utf8");
    expect(JSON.parse(written)).toEqual({
      otro: { command: "mcp-de-prueba" },
      cuybrowser: { type: "stdio", ...launch },
    });
    expect(setup("codex").stdout).toContain("ya está registrado");
    expect(readFileSync(codex, "utf8")).toBe(written);
    const customized = JSON.stringify({ cuybrowser: { type: "http", url: "https://ficticio.invalid" } });
    write(codex, customized);
    expect(setup("codex").status).toBe(1);
    expect(readFileSync(codex, "utf8")).toBe(customized);
    expect(existsSync(claude)).toBe(false);
    expect(existsSync(cursor)).toBe(false);
  });
});
