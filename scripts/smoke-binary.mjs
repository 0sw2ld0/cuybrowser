// Prueba el ejecutable real desde fuera del checkout, sin navegador ni perfil personal.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { daemonInfo, stopDaemon } from "../dist/ipc/client.js";

const [artifact] = process.argv.slice(2);
if (!artifact) throw new Error("Uso: node scripts/smoke-binary.mjs <ejecutable>.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependency = join(repo, "node_modules", "playwright-core");
const info = lstatSync(dependency);
assert(info.isDirectory() && !info.isSymbolicLink(), "Usa una instalación propia de dependencias en este checkout.");
const hidden = `${dependency}.smoke-${randomUUID()}`;
const temp = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "cb-bin-"));
const home = join(temp, "home");
const cuyHome = join(temp, "cuy");
const binary = join(temp, process.platform === "win32" ? "cuybrowser.exe" : "cuybrowser");
const marker = "Página ficticia del ejecutable autónomo";
const server = createServer((_, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>${marker}</title><h1>${marker}</h1>`);
});
let moved = false;
let daemonClosed = false;
let serverStarted = false;
let step = "preparación";

try {
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cuyHome, { mode: 0o700 });
  copyFileSync(resolve(artifact), binary);
  chmodSync(binary, 0o700);
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  serverStarted = true;
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(cuyHome, "policy.yaml"), JSON.stringify({
    origins: { allow: [origin] }, local_network: { allow_origins: [origin] },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, USERPROFILE: home,
    LOCALAPPDATA: home, APPDATA: home, CUYBROWSER_HOME: cuyHome, PLAYWRIGHT_BROWSERS_PATH: join(temp, "browsers"),
    DEBUG: "pw:browser" };
  for (const key of ["NODE_PATH", "NODE_OPTIONS", "CUYBROWSER_BROWSER", "DEBUG_FILE"]) delete env[key];
  process.env.CUYBROWSER_HOME = cuyHome; // Sólo para el IPC de esta prueba, nunca adopta otro daemon.
  renameSync(dependency, hidden);
  moved = true;
  assert(!existsSync(dependency), "El ejecutable no debe encontrar el paquete de la máquina de compilación.");
  const run = promisify(execFile);
  async function tool(name, ...args) {
    step = name;
    const { stdout } = await run(binary, [name, ...args, "--json"], {
      cwd: temp, env, timeout: 40000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    const reply = JSON.parse(stdout);
    assert(reply.ok, `${name}: ${reply.error?.code ?? "respuesta inválida"}`);
    return reply.data;
  }
  await tool("status");
  assert(await daemonInfo(), "El binario debe haber arrancado su propio daemon.");
  await tool("start", "--headless", "--browser", "chrome", "--profile", "ensayo-binario");
  await tool("navigate", `${origin}/`);
  const snapshot = await tool("snapshot");
  assert(snapshot.text.includes(marker), "El binario debe leer la página ficticia en Chromium.");
  await tool("stop");
  console.log("Ejecutable autónomo: arranque, navegación, lectura y parada correctos sin node_modules de Playwright.");
} catch (error) {
  console.error(`Falló el paso ${step} de la prueba del ejecutable.`);
  const daemonLog = join(cuyHome, "daemon.log");
  if (existsSync(daemonLog)) {
    console.error(`Log del daemon de prueba:\n${readFileSync(daemonLog, "utf8").slice(-8192)}`);
  }
  throw error;
} finally {
  try {
    // El hogar fue creado vacío y es exclusivo. Estas dos operaciones IPC no arrancan un daemon.
    process.env.CUYBROWSER_HOME = cuyHome;
    await stopDaemon();
    for (let i = 0; i < 100; i++) {
      if (!await daemonInfo()) {
        daemonClosed = true;
        break;
      }
      await delay(50);
    }
    assert(daemonClosed, "No se pudo cerrar el daemon de la prueba.");
  } finally {
    if (moved) {
      assert(!existsSync(dependency), `Se conservó la dependencia original en ${hidden}.`);
      renameSync(hidden, dependency);
    }
    if (serverStarted) {
      server.closeAllConnections();
      await new Promise((accept) => server.close(accept));
    }
    if (daemonClosed) rmSync(temp, { recursive: true, force: true });
  }
}
