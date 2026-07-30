import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { closeSync, createReadStream, createWriteStream, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const VERSION = "2026.7.3";
const WIN_X64_SHA256 = "8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841";
const WIN_X64_URL = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;

export interface TunnelState {
  status: "stopped" | "installing" | "starting" | "running" | "error";
  url?: string;
  baseUrl?: string;
  pid?: number;
  error?: string;
  reused?: boolean;
  origin?: string;
}

interface StoredTunnel {
  pid: number;
  url: string;
  origin: string;
  version: string;
  startedAt: number;
}

export function parseTunnelUrl(value: string): string | undefined {
  return value.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)?.[0];
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

export class TunnelManager {
  private readonly statePath: string;
  private readonly logPath: string;
  private readonly binPath: string;

  constructor(
    private readonly storage: string,
    private readonly changed: (state: TunnelState) => void,
    private readonly log: (message: string) => void
  ) {
    this.statePath = join(storage, "tunnel.json");
    this.logPath = join(storage, "cloudflared.log");
    this.binPath = join(storage, "bin", "cloudflared.exe");
  }

  async inspect(): Promise<TunnelState> {
    const stored = await this.readState();
    if (!stored || !alive(stored.pid)) return { status: "stopped" };
    return {
      status: "running",
      pid: stored.pid,
      url: stored.url,
      baseUrl: `${stored.url}/v1`,
      reused: true,
      origin: stored.origin
    };
  }

  async start(origin: string): Promise<TunnelState> {
    const stored = await this.readState();
    if (stored && alive(stored.pid) && stored.origin === origin) {
      const state: TunnelState = {
        status: "running",
        pid: stored.pid,
        url: stored.url,
        baseUrl: `${stored.url}/v1`,
        reused: true,
        origin: stored.origin
      };
      this.changed(state);
      return state;
    }
    if (stored && alive(stored.pid)) await this.kill(stored.pid);

    this.changed({ status: "installing" });
    const binary = await this.binary();
    this.changed({ status: "starting" });
    await mkdir(this.storage, { recursive: true });
    await writeFile(this.logPath, "");
    const fd = openSync(this.logPath, "a");
    const child = spawn(binary, [
      "tunnel",
      "--config", process.platform === "win32" ? "NUL" : "/dev/null",
      "--no-autoupdate",
      "--edge-ip-version", "4",
      "--url", origin
    ], {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true
    });
    closeSync(fd);
    if (!child.pid) throw new Error("Cloudflare Tunnel did not start.");
    child.unref();

    let url: string | undefined;
    for (let i = 0; i < 120 && alive(child.pid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      url = parseTunnelUrl(await readFile(this.logPath, "utf8").catch(() => ""));
      if (url) break;
    }
    if (!url) {
      await this.kill(child.pid);
      const tail = (await readFile(this.logPath, "utf8").catch(() => "")).trim().split(/\r?\n/).at(-1);
      throw new Error(tail || "Cloudflare did not return a tunnel URL.");
    }
    const next: StoredTunnel = {
      pid: child.pid,
      url,
      origin,
      version: VERSION,
      startedAt: Date.now()
    };
    await this.writeState(next);
    const state: TunnelState = {
      status: "running",
      pid: child.pid,
      url,
      baseUrl: `${url}/v1`,
      reused: false,
      origin
    };
    this.log(`Tunnel ready at ${url}`);
    this.changed(state);
    return state;
  }

  async stop(): Promise<TunnelState> {
    const stored = await this.readState();
    if (stored && alive(stored.pid)) await this.kill(stored.pid);
    await rm(this.statePath, { force: true });
    const state: TunnelState = { status: "stopped" };
    this.changed(state);
    this.log("Tunnel stopped.");
    return state;
  }

  private async binary(): Promise<string> {
    const override = process.env.UNIFY_CLOUDFLARED_BIN;
    if (override && existsSync(override)) return override;
    if (process.platform !== "win32" || process.arch !== "x64") {
      try {
        const { stdout } = await exec(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"]);
        return stdout.trim().split(/\r?\n/)[0]!;
      } catch {
        throw new Error("This Unify build supports Windows x64. Install cloudflared manually for development on another platform.");
      }
    }
    if (existsSync(this.binPath) && await hash(this.binPath) === WIN_X64_SHA256) return this.binPath;
    await mkdir(join(this.storage, "bin"), { recursive: true });
    const temp = `${this.binPath}.download`;
    await rm(temp, { force: true });
    const response = await fetch(WIN_X64_URL, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body) throw new Error(`cloudflared download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
    if (await hash(temp) !== WIN_X64_SHA256) {
      await rm(temp, { force: true });
      throw new Error("cloudflared checksum verification failed.");
    }
    await rename(temp, this.binPath);
    this.log(`Verified cloudflared ${VERSION}.`);
    return this.binPath;
  }

  private async kill(pid: number): Promise<void> {
    if (!alive(pid)) return;
    if (process.platform === "win32") {
      await exec("taskkill.exe", ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  }

  private async readState(): Promise<StoredTunnel | undefined> {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as StoredTunnel;
      if (!value.url?.startsWith("https://") || !Number.isSafeInteger(value.pid)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private async writeState(value: StoredTunnel): Promise<void> {
    await mkdir(this.storage, { recursive: true });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify(value));
    await rename(temp, this.statePath);
  }
}

export { alive };
