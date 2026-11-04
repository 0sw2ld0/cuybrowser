import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function homeDir(): string {
  return process.env.CUYBROWSER_HOME ?? join(homedir(), ".cuybrowser");
}

export function ensureHome(): string {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function socketPath(): string {
  if (process.platform === "win32") {
    const id = createHash("sha256").update(homeDir()).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\cuybrowser-${id}`;
  }
  return join(homeDir(), "daemon.sock");
}

export function profileDir(profile: string): string {
  return join(homeDir(), "profiles", profile);
}

export function logPath(): string {
  return join(homeDir(), "daemon.log");
}

export function quarantineDir(): string {
  return join(homeDir(), "quarantine");
}

export function downloadsDir(): string {
  return join(homeDir(), "downloads");
}

export function screenshotsDir(): string {
  return join(homeDir(), "screenshots");
}
