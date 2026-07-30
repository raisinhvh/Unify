import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const STORAGE_KEY =
  "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

const helper = `
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => raw += chunk);
process.stdin.on("end", async () => {
  let db;
  try {
    const input = JSON.parse(raw);
    if (input.wait) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      for (const pid of input.pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      const deadline = Date.now() + 120000;
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (input.pids.some(alive) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (input.pids.some(alive)) throw new Error("Cursor did not close.");
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    db = new DatabaseSync(input.db);
    db.exec("PRAGMA busy_timeout=3000");
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(input.key);
    if (!row || typeof row.value !== "string") throw new Error("Cursor settings record was not found.");
    const blob = JSON.parse(row.value);
    if (input.url) {
      blob.openAIBaseUrl = input.url.replace(/\\/+$/, "");
      db.prepare("UPDATE ItemTable SET value = ? WHERE key = ?").run(JSON.stringify(blob), input.key);
    }
    process.stdout.write(JSON.stringify(blob));
    if (input.wait) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_NO_WARNINGS;
      delete env.VSCODE_IPC_HOOK;
      delete env.VSCODE_IPC_HOOK_CLI;
      delete env.VSCODE_PID;
      spawn(input.exe, ["--classic"], { detached: true, stdio: "ignore", env }).unref();
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
});
`;

interface CursorState {
  openAIBaseUrl?: unknown;
}

export class CursorUrl {
  constructor(private readonly db: string) {}

  available(): boolean {
    return process.platform === "win32" && existsSync(this.db);
  }

  async read(): Promise<string | undefined> {
    const state = await this.run(false);
    return typeof state.openAIBaseUrl === "string" ? state.openAIBaseUrl : undefined;
  }

  async schedule(url: string): Promise<void> {
    await this.run(true, url);
  }

  private run(wait: boolean, url?: string): Promise<CursorState> {
    if (!this.available()) return Promise.reject(new Error("Cursor URL updates are unavailable on this installation."));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", helper], {
        detached: wait,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", wait ? "ignore" : "pipe", wait ? "ignore" : "pipe"],
        windowsHide: true
      });
      if (wait) {
        child.once("error", reject);
        child.once("spawn", () => {
          child.stdin!.end(JSON.stringify({
            wait,
            url,
            db: this.db,
            key: STORAGE_KEY,
            exe: process.execPath,
            pids: [process.ppid, process.pid]
          }), () => {
            child.unref();
            resolve({});
          });
        });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout?.on("data", (value: Buffer) => out.push(value));
      child.stderr?.on("data", (value: Buffer) => err.push(value));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(err).toString("utf8") || "Cursor URL read failed."));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString("utf8")) as CursorState);
        } catch {
          reject(new Error("Cursor returned invalid settings."));
        }
      });
      child.stdin!.end(JSON.stringify({ wait, db: this.db, key: STORAGE_KEY }));
    });
  }
}
