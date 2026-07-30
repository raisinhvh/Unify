import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { AuthManager } from "./auth";
import {
  settings,
  updateSettings,
  validReasoning,
  validSpeed,
  validateModels,
  type ModelConfig,
  type ModelEffort,
  type ModelSpeed,
  type UnifySettings
} from "./config";
import { Dashboard, type DashboardMessage, type DashboardState } from "./dashboard";
import { CursorUrl } from "./cursor-url";
import { GatewayServer, probe } from "./server";
import { TunnelManager, type TunnelState } from "./tunnel";
import { UsageStore } from "./usage";

const PORT = 47822;
const KEY = "unify.proxyKey";
const SETUP_NEEDED = "unify.setupNeeded";
const MANUAL_SETUP_NEEDED = "unify.manualSetupNeeded";
const CURSOR_URL_HANDLED = "unify.cursorUrlHandled.v3";
const DEFAULT_THEME_APPLIED = "unify.defaultThemeApplied.v1";

function newKey(): string {
  return `ufy_${randomBytes(32).toString("base64url")}`;
}

export class UnifyController implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel("Unify");
  private readonly auth: AuthManager;
  private readonly gateway: GatewayServer;
  private readonly tunnel: TunnelManager;
  private readonly dashboard: Dashboard;
  private readonly usage: UsageStore;
  private readonly cursorUrl: CursorUrl;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 12);
  private readonly subscriptions: vscode.Disposable[] = [];
  private tunnelState: TunnelState = { status: "stopped" };
  private serverReady = false;
  private gatewayPort?: number;
  private error?: string;
  private poll?: NodeJS.Timeout;
  private promptingCursor = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.auth = new AuthManager(context.secrets, () => void this.dashboard?.refresh());
    this.usage = new UsageStore(context.globalState);
    this.cursorUrl = new CursorUrl(join(dirname(context.globalStorageUri.fsPath), "state.vscdb"));
    this.gateway = new GatewayServer(
      this.auth,
      () => this.key(),
      (value) => this.log(value),
      undefined,
      (sample) => {
        const provider = settings().models.find((model) => model.frontend === sample.model)?.provider ?? "chatgpt";
        this.usage.record(sample, provider);
        void this.dashboard?.refresh();
      }
    );
    this.tunnel = new TunnelManager(
      context.globalStorageUri.fsPath,
      (value) => {
        this.tunnelState = value;
        this.error = value.error;
        this.render();
      },
      (value) => this.log(value)
    );
    this.dashboard = new Dashboard((message) => this.handle(message), () => this.viewState());
    this.status.command = "unify.quickControls";
    this.status.name = "Unify";
    this.status.show();
    this.subscriptions.push(
      this.output,
      this.status,
      this.auth,
      this.dashboard,
      vscode.commands.registerCommand("unify.open", () => this.dashboard.open()),
      vscode.commands.registerCommand("unify.quickControls", () => this.quickControls()),
      vscode.commands.registerCommand("unify.startTunnel", () => this.startTunnel()),
      vscode.commands.registerCommand("unify.stopTunnel", () => this.stopTunnel()),
      vscode.commands.registerCommand("unify.copyBaseUrl", () => this.copy("baseUrl")),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("unify")) this.render();
      })
    );
  }

  async activate(): Promise<void> {
    if (!this.context.globalState.get(DEFAULT_THEME_APPLIED, false)) {
      await updateSettings({ theme: "default" });
      await this.context.globalState.update(DEFAULT_THEME_APPLIED, true);
    }
    await this.key();
    this.serverReady = await this.ensureGateway();
    this.tunnelState = await this.tunnel.inspect();
    if (settings().localMode && this.tunnelState.status === "running") {
      this.tunnelState = await this.tunnel.stop();
    } else if (this.tunnelState.status === "running" && this.tunnelState.origin !== this.origin()) {
      this.tunnelState = await this.tunnel.start(this.origin());
    }
    this.render();
    this.poll = setInterval(() => void this.reconcile(), 5000);
    this.poll.unref();

    if (settings().localMode || this.tunnelState.status === "running") {
      void this.configureCursorUrl();
      return;
    }
    const mode = settings().tunnelMode;
    if (mode === "automatic") {
      void this.startTunnel().catch((error) => this.fail(error));
    }
    if (mode === "prompt") {
      void this.promptTunnelStart();
    }
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    void this.gateway.close();
    for (const item of this.subscriptions) item.dispose();
  }

  private async handle(message: DashboardMessage): Promise<void> {
    if (message.type === "tunnel") {
      if (message.action === "start") await this.startTunnel();
      else await this.stopTunnel();
      return;
    }
    if (message.type === "auth") {
      if (message.action === "disconnect") {
        await this.auth.disconnect(message.provider);
        this.dashboard.notice(`${message.provider === "claude" ? "Claude" : "ChatGPT"} disconnected.`);
      } else if (message.provider === "claude") {
        await this.auth.startClaude();
      } else {
        await this.auth.startChatGPT();
      }
      return;
    }
    if (message.type === "claudeCode") {
      await this.auth.finishClaude(message.code);
      this.dashboard.notice("Claude connected.");
      return;
    }
    if (message.type === "settings") {
      await this.saveSettings(message.values);
      return;
    }
    if (message.type === "copy") {
      await this.copy(message.value);
      return;
    }
    if (message.type === "openCursorSettings") {
      await this.openCursorModels();
      return;
    }
    if (message.type === "rotateKey") {
      await this.context.secrets.store(KEY, newKey());
      await this.context.globalState.update(MANUAL_SETUP_NEEDED, true);
      await this.context.globalState.update(SETUP_NEEDED, true);
      this.dashboard.notice("Bridge key rotated. Update it in Cursor.");
    }
  }

  private async saveSettings(values: Partial<UnifySettings>): Promise<void> {
    const previous = settings();
    if (values.cursorUrlMode === "automatic" && previous.cursorUrlMode !== "automatic") {
      const choice = await vscode.window.showWarningMessage(
        "This feature has the potential to break in future Cursor updates, and it could potentially corrupt settings due to its risky nature. Do you wish to proceed?",
        { modal: true },
        "Proceed"
      );
      if (choice !== "Proceed") {
        this.dashboard.notice("Automatic URL override remains off.");
        return;
      }
    }
    if (values.reasoning !== undefined && !validReasoning(values.reasoning)) {
      throw new Error("Choose a valid reasoning effort.");
    }
    if (values.speed !== undefined && !validSpeed(values.speed)) {
      throw new Error("Choose a valid speed.");
    }
    if (values.models !== undefined) {
      const models: ModelConfig[] = values.models.map((model) => ({
        ...model,
        frontend: model.frontend.trim(),
        backend: model.backend.trim()
      }));
      validateModels(models);
      values.models = models;
      await this.context.globalState.update(MANUAL_SETUP_NEEDED, true);
      await this.context.globalState.update(SETUP_NEEDED, true);
    }
    if (values.deepPromptValidator !== undefined) values.deepPromptValidator = values.deepPromptValidator.trim();
    const next = { ...previous, ...values };
    if (next.deepPrompt) {
      const names = next.models.filter((model) => model.enabled).map((model) => model.frontend.toLowerCase());
      if (!names.includes(next.deepPromptValidator.toLowerCase())) throw new Error(`Validator model "${next.deepPromptValidator}" is not enabled.`);
    }
    await updateSettings(values);
    this.dashboard.notice("Saved.");
    if (values.localMode === true && !previous.localMode) {
      if (this.tunnelState.status === "running") this.tunnelState = await this.tunnel.stop();
      this.render();
      void this.configureCursorUrl();
    }
    if (values.localMode === false && previous.localMode) {
      const mode = settings().tunnelMode;
      if (mode === "automatic") void this.startTunnel().catch((error) => this.fail(error));
      if (mode === "prompt") void this.promptTunnelStart();
    }
  }

  private async startTunnel(): Promise<void> {
    if (settings().localMode) {
      void this.configureCursorUrl();
      return;
    }
    this.error = undefined;
    if (!this.serverReady) {
      this.serverReady = await this.ensureGateway();
      if (!this.serverReady) throw new Error("The local inference gateway could not start. Open Unify output for details.");
    }
    const state = await this.tunnel.start(this.origin());
    this.tunnelState = state;
    this.render();
    void this.configureCursorUrl();
  }

  private async stopTunnel(): Promise<void> {
    this.error = undefined;
    this.tunnelState = await this.tunnel.stop();
    this.render();
  }

  private async copy(value: "baseUrl" | "key" | string): Promise<void> {
    let content = "";
    if (value === "baseUrl") content = this.baseUrl() ?? "";
    if (value === "key") content = await this.key();
    if (value === "models") content = settings().models.filter((model) => model.enabled).map((model) => model.frontend).join("\n");
    if (value.startsWith("model:")) content = value.slice(6);
    if (!content) throw new Error("Start the tunnel first.");
    await vscode.env.clipboard.writeText(content);
    this.dashboard.notice(
      value === "key" ? "Bridge key copied."
        : value === "baseUrl" ? "Base URL copied."
          : value === "models" ? "Model names copied."
            : "Model name copied."
    );
  }

  private async quickControls(): Promise<void> {
    const current = settings();
    const items: Array<vscode.QuickPickItem & { effort?: ModelEffort; speed?: ModelSpeed; open?: boolean }> = [
      { label: "Effort", kind: vscode.QuickPickItemKind.Separator },
      ...(["low", "medium", "high", "xhigh", "max"] as ModelEffort[]).map((effort) => ({
        label: `${current.reasoning === effort ? "$(check)" : "$(circle-large-outline)"} ${effort === "xhigh" ? "XHigh" : effort[0]!.toUpperCase() + effort.slice(1)}`,
        effort
      })),
      { label: "Speed", kind: vscode.QuickPickItemKind.Separator },
      ...(["standard", "fast"] as ModelSpeed[]).map((speed) => ({
        label: `${current.speed === speed ? "$(check)" : "$(circle-large-outline)"} ${speed[0]!.toUpperCase() + speed.slice(1)}`,
        speed
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: "$(dashboard) Open Unify", open: true }
    ];
    const choice = await vscode.window.showQuickPick(items, { placeHolder: "Unify · Effort and speed" });
    if (!choice) return;
    if (choice.open) {
      await this.dashboard.open();
      return;
    }
    if (choice.effort) await updateSettings({ reasoning: choice.effort });
    if (choice.speed) await updateSettings({ speed: choice.speed });
    this.render();
    const next = settings();
    void vscode.window.setStatusBarMessage(`Unify · ${next.reasoning === "xhigh" ? "XHigh" : next.reasoning} · ${next.speed}`, 1800);
  }

  private async key(): Promise<string> {
    const existing = await this.context.secrets.get(KEY);
    if (existing) return existing;
    const value = newKey();
    await this.context.secrets.store(KEY, value);
    await this.context.globalState.update(MANUAL_SETUP_NEEDED, true);
    await this.context.globalState.update(SETUP_NEEDED, true);
    return value;
  }

  private async reconcile(): Promise<void> {
    if (!this.serverReady || !this.gatewayPort || !await probe(this.gatewayPort, await this.key())) {
      this.serverReady = await this.ensureGateway();
    }
    if (settings().localMode) {
      this.render();
      void this.configureCursorUrl();
      return;
    }
    const tunnel = await this.tunnel.inspect();
    if (tunnel.status === "running" && tunnel.origin !== this.origin()) {
      this.tunnelState = await this.tunnel.start(this.origin());
    } else if (tunnel.status !== this.tunnelState.status || tunnel.url !== this.tunnelState.url) {
      this.tunnelState = tunnel;
    }
    this.render();
    if (this.tunnelState.status === "running") void this.configureCursorUrl();
  }

  private async viewState(): Promise<DashboardState> {
    const config = settings();
    const tunnel: TunnelState = config.localMode
      ? {
          status: this.serverReady ? "running" : "error",
          url: this.origin(),
          baseUrl: this.baseUrl(),
          origin: this.origin(),
          error: this.serverReady ? undefined : "The local gateway is unavailable."
        }
      : this.tunnelState;
    return {
      tunnel,
      settings: config,
      auth: await this.auth.status(),
      serverReady: this.serverReady,
      setupNeeded: this.context.globalState.get(SETUP_NEEDED, true),
      usage: await this.usage.snapshot(),
      history: await this.usage.history(),
      error: this.error
    };
  }

  private render(): void {
    const config = settings();
    const local = config.localMode;
    const running = local ? this.serverReady : this.tunnelState.status === "running";
    const effort = config.reasoning === "xhigh" ? "XHigh" : config.reasoning[0]!.toUpperCase() + config.reasoning.slice(1);
    const speed = config.speed === "fast" ? "Fast" : "Standard";
    this.status.text = `${running ? "$(shield)" : "$(shield-x)"} Unify · ${effort} · ${speed}`;
    const state = running
      ? `Unify is running\n${this.baseUrl() ?? ""}`
      : this.error ?? (local ? "Unify local gateway is unavailable" : "Unify tunnel is stopped");
    this.status.tooltip = `${state}\n\nClick to change effort or speed.`;
    void this.dashboard.refresh();
  }

  private fail(error: unknown): void {
    this.error = error instanceof Error ? error.message : "Unify failed.";
    this.tunnelState = { status: "error", error: this.error };
    this.log(this.error);
    this.render();
    void vscode.window.showErrorMessage(`Unify: ${this.error}`);
  }

  private origin(): string {
    return `http://127.0.0.1:${this.gatewayPort ?? PORT}`;
  }

  private baseUrl(): string | undefined {
    return settings().localMode && this.serverReady ? `${this.origin()}/v1` : this.tunnelState.baseUrl;
  }

  private async ensureGateway(): Promise<boolean> {
    const key = await this.key();
    if (this.gatewayPort && await probe(this.gatewayPort, key)) return true;
    if (this.gateway.port()) await this.gateway.close();
    if (await this.gateway.listen(PORT)) {
      this.gatewayPort = this.gateway.port() ?? PORT;
      return true;
    }
    if (await probe(PORT, key)) {
      this.gatewayPort = PORT;
      this.log(`Using the gateway owned by another Unify window on 127.0.0.1:${PORT}.`);
      return true;
    }
    this.log(`Port ${PORT} is occupied. Starting Unify on an available local port.`);
    if (await this.gateway.listen(0)) {
      this.gatewayPort = this.gateway.port();
      return Boolean(this.gatewayPort);
    }
    return false;
  }

  private async promptTunnelStart(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "Start Unify's secure tunnel?",
      "Start",
      "Not now"
    );
    if (choice === "Start") await this.startTunnel().catch((error) => this.fail(error));
  }

  private async configureCursorUrl(): Promise<void> {
    const baseUrl = this.baseUrl();
    if (!baseUrl || this.promptingCursor || this.context.globalState.get(CURSOR_URL_HANDLED) === baseUrl) return;
    this.promptingCursor = true;
    try {
      const updated = await this.tryCursorSetting(baseUrl);
      if (updated) {
        await this.context.globalState.update(CURSOR_URL_HANDLED, baseUrl);
        const manualSetup = this.context.globalState.get(MANUAL_SETUP_NEEDED, false);
        await this.context.globalState.update(SETUP_NEEDED, manualSetup);
        this.log("Cursor's OpenAI Base URL was updated automatically.");
        this.dashboard.notice("Cursor Base URL updated.");
        this.render();
        return;
      }
      if (this.cursorUrl.available() && this.sameUrl(await this.cursorUrl.read(), baseUrl)) {
        await this.context.globalState.update(CURSOR_URL_HANDLED, baseUrl);
        const manualSetup = this.context.globalState.get(MANUAL_SETUP_NEEDED, false);
        await this.context.globalState.update(SETUP_NEEDED, manualSetup);
        this.render();
        return;
      }
      await this.context.globalState.update(SETUP_NEEDED, true);
      this.render();
      const automatic = settings().cursorUrlMode === "automatic";
      const choice = automatic
        ? "Restart"
        : await vscode.window.showInformationMessage(
            "Apply Unify's new tunnel URL? Cursor will fully restart.",
            "Restart",
            "Later"
          );
      if (choice === "Restart" && this.cursorUrl.available()) {
        await vscode.commands.executeCommand("workbench.action.files.saveAll");
        if (vscode.workspace.textDocuments.some((document) => document.isDirty)) {
          void vscode.window.showWarningMessage("Save or close unsaved files before Unify restarts Cursor.");
          return;
        }
        await this.cursorUrl.schedule(baseUrl);
        this.log("Cursor URL update scheduled; restarting the classic IDE.");
        return;
      }
      await this.context.globalState.update(CURSOR_URL_HANDLED, baseUrl);
      if (choice === "Restart") await this.openCursorModels();
    } catch (error) {
      this.log(`Cursor Base URL update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.promptingCursor = false;
    }
  }

  private async tryCursorSetting(baseUrl: string): Promise<boolean> {
    const candidates = [
      { section: "cursor.general", key: "openAIBaseURL" },
      { section: "cursor.general", key: "openAIBaseUrl" },
      { section: "cursor", key: "openAIBaseURL" },
      { section: "cursor", key: "openAIBaseUrl" }
    ];
    for (const candidate of candidates) {
      const config = vscode.workspace.getConfiguration(candidate.section);
      if (!config.inspect<string>(candidate.key)) continue;
      try {
        await config.update(candidate.key, baseUrl, vscode.ConfigurationTarget.Global);
        if (this.sameUrl(config.get<string>(candidate.key), baseUrl)) return true;
      } catch (error) {
        this.log(`Cursor setting ${candidate.section}.${candidate.key} rejected the update: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return false;
  }

  private sameUrl(left: string | undefined, right: string): boolean {
    const normalize = (value: string | undefined) => value?.trim().replace(/\/+$/, "");
    return normalize(left) === normalize(right);
  }

  private async openCursorModels(): Promise<void> {
    const baseUrl = this.baseUrl();
    if (baseUrl) await vscode.env.clipboard.writeText(baseUrl);
    try {
      await vscode.commands.executeCommand("aiSettings.action.openhidden");
    } catch {
      void vscode.window.showWarningMessage("Unify could not open Cursor Settings. Press Ctrl+Shift+J, then choose Models.");
    }
    this.dashboard.notice("Base URL copied. In Cursor Settings, choose Models and paste it.");
  }

  private log(message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }
}
