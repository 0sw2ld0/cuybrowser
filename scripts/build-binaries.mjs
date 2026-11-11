#!/usr/bin/env node
// Compila un binario por plataforma en release/. Uso: node scripts/build-binaries.mjs [--current]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TARGETS = [
  ["bun-darwin-arm64", "cuybrowser-macos-arm64"],
  ["bun-darwin-x64", "cuybrowser-macos-x64"],
  ["bun-linux-x64", "cuybrowser-linux-x64"],
  ["bun-linux-arm64", "cuybrowser-linux-arm64"],
  ["bun-windows-x64", "cuybrowser-windows-x64.exe"],
];

const out = "release";
const onlyCurrent = process.argv.includes("--current");
// El paquete npm instala el ejecutable aquí en los tres sistemas. execFileSync no ejecuta .cmd.
const bun = join("node_modules", "bun", "bin", "bun.exe");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const targets = onlyCurrent ? [[null, `cuybrowser${process.platform === "win32" ? ".exe" : ""}`]] : TARGETS;
const checksums = [];
for (const [target, name] of targets) {
  const path = join(out, name);
  console.log(`Compilando ${name}`);
  execFileSync(
    bun,
    ["scripts/compile-binary.mjs", path, ...(target ? [target] : [])],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  checksums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${name}`);
}
writeFileSync(join(out, "SHA256SUMS"), `${checksums.join("\n")}\n`);
console.log(`Listo: ${checksums.length} binarios en ${out}/`);
