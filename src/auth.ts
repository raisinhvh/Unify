import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import * as vscode from "vscode";

export type Provider = "claude" | "chatgpt";

interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  accountId?: string;
}

interface ClaudeSession {
  verifier: string;
  state: string;
  expiresAt: number;
}

const CLAUDE_KEY = "unify.auth.claude";
const CHATGPT_KEY = "unify.auth.chatgpt";
const CLAUDE_CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OPENAI_CLIENT = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_REDIRECT = "http://localhost:1455/auth/callback";

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function accountId(payload: Record<string, unknown>): string | undefined {
  const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

export class AuthManager implements vscode.Disposable {
  private claudeSession?: ClaudeSession;
  private callback?: Server;
  private callbackTimer?: NodeJS.Timeout;
  private chatgptPending = false;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly changed: () => void
  ) {}

  async status(): Promise<Record<Provider, { connected: boolean; email?: string; pending?: boolean }>> {
    const [claude, chatgpt] = await Promise.all([this.read("claude"), this.read("chatgpt")]);
    return {
      claude: {
        connected: Boolean(claude?.accessToken),
        email: claude?.email,
        pending: Boolean(this.claudeSession)
      },
      chatgpt: {
        connected: Boolean(chatgpt?.accessToken),
        email: chatgpt?.email,
        pending: this.chatgptPending
      }
    };
  }

  async startClaude(): Promise<void> {
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(24));
    this.claudeSession = { verifier, state, expiresAt: Date.now() + 10 * 60_000 };
    const params = new URLSearchParams({
      code: "true",
      response_type: "code",
      client_id: CLAUDE_CLIENT,
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      scope: "org:create_api_key user:profile user:inference",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state
    });
    await vscode.env.openExternal(vscode.Uri.parse(`https://claude.ai/oauth/authorize?${params}`));
    this.changed();
  }

  async finishClaude(input: string): Promise<void> {
    const session = this.claudeSession;
    if (!session || session.expiresAt <= Date.now()) {
      this.claudeSession = undefined;
      throw new Error("The Claude sign-in expired. Start it again.");
    }
    const [code, returnedState] = input.trim().split("#");
    if (!code || (returnedState && returnedState !== session.state)) {
      throw new Error("The Claude authorization code is invalid.");
    }
    this.claudeSession = undefined;
    const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: CLAUDE_CLIENT,
        redirect_uri: "https://console.anthropic.com/oauth/code/callback",
        code,
        state: returnedState ?? session.state,
        code_verifier: session.verifier
      })
    });
    const data = await this.tokenResponse(response);
    const account = data.account as Record<string, unknown> | undefined;
    await this.write("claude", {
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token ?? ""),
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
      email: typeof account?.email_address === "string" ? account.email_address : undefined
    });
    this.changed();
  }

  async startChatGPT(): Promise<void> {
    await this.stopCallback();
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(24));
    this.chatgptPending = true;
    await this.startCallback(async (url) => {
      if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
        throw new Error("OpenAI returned an invalid sign-in response.");
      }
      const response = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OPENAI_CLIENT,
          code: url.searchParams.get("code")!,
          redirect_uri: OPENAI_REDIRECT,
          code_verifier: verifier
        })
      });
      const data = await this.tokenResponse(response);
      const jwt = decodeJwt(String(data.id_token ?? ""));
      await this.write("chatgpt", {
        accessToken: String(data.access_token),
        refreshToken: String(data.refresh_token ?? ""),
        expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
        email: typeof jwt.email === "string" ? jwt.email : undefined,
        accountId: accountId(jwt)
      });
      this.chatgptPending = false;
      this.changed();
    });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: OPENAI_CLIENT,
      redirect_uri: OPENAI_REDIRECT,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      state
    });
    await vscode.env.openExternal(vscode.Uri.parse(`https://auth.openai.com/oauth/authorize?${params}`));
    this.changed();
  }

  async disconnect(provider: Provider): Promise<void> {
    await this.secrets.delete(provider === "claude" ? CLAUDE_KEY : CHATGPT_KEY);
    if (provider === "claude") this.claudeSession = undefined;
    if (provider === "chatgpt") {
      this.chatgptPending = false;
      await this.stopCallback();
    }
    this.changed();
  }

  async token(provider: Provider): Promise<Credentials> {
    const current = await this.read(provider);
    if (!current) throw new Error(`${provider === "claude" ? "Claude" : "ChatGPT"} is not connected.`);
    if (current.expiresAt > Date.now() + 60_000) return current;
    if (!current.refreshToken) throw new Error(`${provider} sign-in expired. Reconnect it in Unify.`);

    const response = await fetch(
      provider === "claude" ? "https://console.anthropic.com/v1/oauth/token" : "https://auth.openai.com/oauth/token",
      provider === "claude"
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: current.refreshToken,
              client_id: CLAUDE_CLIENT
            })
          }
        : {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: current.refreshToken,
              client_id: OPENAI_CLIENT
            })
          }
    );
    const data = await this.tokenResponse(response);
    const next = {
      ...current,
      accessToken: String(data.access_token),
      refreshToken: String(data.refresh_token ?? current.refreshToken),
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000
    };
    await this.write(provider, next);
    return next;
  }

  dispose(): void {
    void this.stopCallback();
  }

  private async startCallback(complete: (url: URL) => Promise<void>): Promise<void> {
    this.callback = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", OPENAI_REDIRECT);
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end();
        return;
      }
      try {
        await complete(url);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><title>Unify</title><style>body{font:16px system-ui;background:#111318;color:#f5f3ff;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center}</style><main><h1>Connected</h1><p>You can close this window.</p></main>");
      } catch (error) {
        this.chatgptPending = false;
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : "Sign-in failed.");
        this.changed();
      } finally {
        setImmediate(() => void this.stopCallback());
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.callback!.once("error", reject);
      this.callback!.listen(1455, "127.0.0.1", resolve);
    });
    this.callbackTimer = setTimeout(() => {
      this.chatgptPending = false;
      void this.stopCallback();
      this.changed();
    }, 10 * 60_000);
    this.callbackTimer.unref();
  }

  private async stopCallback(): Promise<void> {
    if (this.callbackTimer) clearTimeout(this.callbackTimer);
    this.callbackTimer = undefined;
    const server = this.callback;
    this.callback = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async tokenResponse(response: Response): Promise<Record<string, unknown>> {
    if (!response.ok) throw new Error(`Sign-in failed (${response.status}).`);
    return (await response.json()) as Record<string, unknown>;
  }

  private async read(provider: Provider): Promise<Credentials | undefined> {
    const value = await this.secrets.get(provider === "claude" ? CLAUDE_KEY : CHATGPT_KEY);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as Credentials;
    } catch {
      return undefined;
    }
  }

  private async write(provider: Provider, credentials: Credentials): Promise<void> {
    await this.secrets.store(provider === "claude" ? CLAUDE_KEY : CHATGPT_KEY, JSON.stringify(credentials));
  }
}
