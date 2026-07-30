import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Provider } from "./auth";
import type { ModelConfig, UnifySettings } from "./config";
import type { TunnelState } from "./tunnel";
import type { UsageEntry, UsagePoint } from "./usage";

export interface DashboardState {
  tunnel: TunnelState;
  settings: UnifySettings;
  auth: Record<Provider, { connected: boolean; email?: string; pending?: boolean }>;
  usage: UsagePoint[];
  history: UsageEntry[];
  serverReady: boolean;
  setupNeeded: boolean;
  error?: string;
}

export type DashboardMessage =
  | { type: "ready" }
  | { type: "tunnel"; action: "start" | "stop" }
  | { type: "auth"; provider: Provider; action: "connect" | "disconnect" }
  | { type: "claudeCode"; code: string }
  | { type: "settings"; values: Partial<UnifySettings> }
  | { type: "copy"; value: string }
  | { type: "openCursorSettings" }
  | { type: "rotateKey" };

export class Dashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private readyTimer?: NodeJS.Timeout;

  constructor(
    private readonly handle: (message: DashboardMessage) => Promise<void>,
    private readonly state: () => Promise<DashboardState>
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      if (!this.ready) this.panel.webview.html = html(this.panel.webview);
      await this.refresh();
      return;
    }
    this.panel = vscode.window.createWebviewPanel("unify.dashboard", "Unify", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true
    });
    this.panel.onDidDispose(() => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.panel = undefined;
      this.ready = false;
    });
    this.panel.webview.onDidReceiveMessage(async (message: DashboardMessage) => {
      if (message.type === "ready") {
        this.ready = true;
        if (this.readyTimer) clearTimeout(this.readyTimer);
        await this.refresh();
        return;
      }
      try {
        await this.handle(message);
      } catch (error) {
        this.notice(error instanceof Error ? error.message : "Action failed.", true);
      }
      await this.refresh();
    });
    this.panel.webview.html = html(this.panel.webview);
    this.readyTimer = setTimeout(() => {
      if (!this.panel || this.ready) return;
      this.panel.webview.html = html(this.panel.webview);
      void this.refresh();
      this.readyTimer = setTimeout(async () => {
        if (!this.panel || this.ready) return;
        const choice = await vscode.window.showWarningMessage(
          "Unify's dashboard could not initialize. Reload Cursor to repair the webview?",
          "Reload Cursor"
        );
        if (choice === "Reload Cursor") await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }, 2500);
      this.readyTimer.unref();
    }, 2500);
    this.readyTimer.unref();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.panel) await this.panel.webview.postMessage({ type: "state", value: await this.state() });
  }

  notice(message: string, error = false): void {
    void this.panel?.webview.postMessage({ type: "notice", message, error });
  }

  dispose(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.panel?.dispose();
  }
}

function html(webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString("base64");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} data:`
  ].join("; ");
  return `<!doctype html>
<html lang="en" data-theme="default">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Unify</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --bg: #140a0d;
      --bg-mid: #10090b;
      --bg-end: #0b0809;
      --surface: #1b1114;
      --strong: #26171b;
      --raised: #342126;
      --menu: #211216;
      --menu-text: #fff8fa;
      --text: #fff4f7;
      --muted: #aaa0a3;
      --accent: #c84557;
      --accent-soft: #b83a4c;
      --accent-text: #fff;
      --good: #62dda1;
      --warn: #f4b85d;
      --bad: #ff5570;
      --activity-0: #24272a;
      --activity-1: #123c25;
      --activity-2: #176b35;
      --activity-3: #239e4b;
      --activity-4: #4bd36f;
      --synapse: 200, 69, 87;
    }
    html[data-theme="dark"] {
      --bg: #0b0d10;
      --bg-mid: #111311;
      --bg-end: #08090a;
      --surface: #12151a;
      --strong: #1a1e21;
      --raised: #292d30;
      --menu: #202326;
      --menu-text: #f7f8fa;
      --text: #f4f5f7;
      --muted: #9aa2ae;
      --accent: #ffb000;
      --accent-soft: #ffd054;
      --accent-text: #17130a;
      --good: #63d99a;
      --warn: #eeb45d;
      --bad: #ef6670;
      --activity-0: #25282a;
      --synapse: 255, 176, 0;
    }
    html[data-theme="incognito"] {
      --bg: #040506;
      --bg-mid: #070809;
      --bg-end: #010202;
      --surface: #090b0d;
      --strong: #101316;
      --raised: #1a1d21;
      --menu: #0c0e10;
      --menu-text: #f4f5f6;
      --text: #eff1f3;
      --muted: #858d96;
      --accent: #b6bec7;
      --accent-soft: #d9dee3;
      --accent-text: #090b0d;
      --good: #5dcc91;
      --warn: #d9aa55;
      --bad: #d96370;
      --activity-0: #171a1d;
      --synapse: 164, 174, 184;
    }
    html[data-theme="aquamint"] {
      --bg: #04a864;
      --bg-mid: #08c598;
      --bg-end: #35baf4;
      --surface: #073738;
      --strong: #0c4948;
      --raised: #135e5b;
      --menu: #062e39;
      --menu-text: #f2fffd;
      --text: #effffa;
      --muted: #a5d7d1;
      --accent: #55e9ff;
      --accent-soft: #8df2ff;
      --accent-text: #062127;
      --good: #57efa3;
      --warn: #ffd166;
      --bad: #ff7583;
      --activity-0: #173936;
      --synapse: 116, 255, 222;
    }
    html[data-theme="sophisticated"] {
      --bg: #1d140f;
      --bg-mid: #15100c;
      --bg-end: #0d0a08;
      --surface: #241a14;
      --strong: #33251b;
      --raised: #493727;
      --menu: #2c1f17;
      --menu-text: #f8eee2;
      --text: #f3eadf;
      --muted: #b4a08a;
      --accent: #c59a68;
      --accent-soft: #dec09a;
      --accent-text: #21150d;
      --good: #72c28d;
      --warn: #d9a34f;
      --bad: #d96d62;
      --activity-0: #332b24;
      --synapse: 197, 154, 104;
    }
    html[data-theme="violet"] {
      --bg: #0d0815;
      --bg-mid: #100d17;
      --bg-end: #09080e;
      --surface: #161021;
      --strong: #21172f;
      --raised: #2a1d3d;
      --menu: #251733;
      --menu-text: #fbf7ff;
      --text: #f8f3ff;
      --muted: #ae9abd;
      --accent: #a96dff;
      --accent-soft: #c69cff;
      --accent-text: #160b24;
      --good: #65dca0;
      --warn: #efb65f;
      --bad: #f06d80;
      --activity-0: #271c36;
      --synapse: 169, 109, 255;
    }
    html[data-theme="honeycomb"] {
      color-scheme: light;
      --bg: #fff4bd;
      --bg-mid: #f8dc77;
      --bg-end: #d9a441;
      --surface: #fff9dc;
      --strong: #f3df9b;
      --raised: #dfbd69;
      --menu: #70481f;
      --menu-text: #fff8dc;
      --text: #3f2b16;
      --muted: #795c32;
      --accent: #e6a817;
      --accent-soft: #f4c84a;
      --accent-text: #352307;
      --good: #3f8550;
      --warn: #a5680d;
      --bad: #b74432;
      --activity-0: #eadca9;
      --synapse: 190, 129, 28;
    }
    html[data-theme="skid"] {
      --bg: #010402;
      --bg-mid: #061008;
      --bg-end: #000201;
      --surface: #07100a;
      --strong: #0b1b10;
      --raised: #12331b;
      --menu: #020b04;
      --menu-text: #b9ffbf;
      --text: #caffce;
      --muted: #72a879;
      --accent: #25e13f;
      --accent-soft: #64f276;
      --accent-text: #001e05;
      --good: #40ed65;
      --warn: #c9d94a;
      --bad: #ff5564;
      --activity-0: #0a1c0e;
      --synapse: 37, 225, 63;
    }
    html[data-theme="light"] {
      color-scheme: light;
      --bg: #ece8e7;
      --bg-mid: #e5e1e0;
      --bg-end: #dcd8d7;
      --surface: #faf8f7;
      --strong: #e2dcda;
      --raised: #d7cfcd;
      --menu: #20191c;
      --menu-text: #fff8fa;
      --text: #1b1517;
      --muted: #6d6064;
      --accent: #c62149;
      --accent-soft: #a7193b;
      --accent-text: #fff;
      --good: #168453;
      --warn: #986112;
      --bad: #bd2f49;
      --activity-0: #ded7d5;
      --synapse: 198, 33, 73;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 560px;
      background: linear-gradient(145deg, var(--bg) 0%, var(--bg-mid) 58%, var(--bg-end) 100%);
      background-attachment: fixed;
      color: var(--text);
      font: 600 14px/1.42 "Bahnschrift", "Arial Narrow", "Segoe UI", sans-serif;
      letter-spacing: -.01em;
      transition: background .22s ease, color .22s ease;
    }
    button, input, select { font: inherit; border: 0; border-radius: 0; }
    button { cursor: pointer; font-weight: 750; }
    #synapses { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; opacity: .72; }
    .shell { position: relative; z-index: 1; max-width: 1040px; margin: 0 auto; padding: 18px 30px 56px; }
    header {
      height: 54px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 8px 0 17px;
      background: var(--menu);
      color: var(--menu-text);
    }
    .brand { display: flex; align-items: center; height: 100%; padding-top: 3px; font-size: 19px; line-height: 1; font-weight: 850; letter-spacing: .14em; }
    nav { display: flex; align-items: stretch; gap: 4px; height: 100%; padding: 0; }
    .tab {
      background: transparent;
      color: color-mix(in srgb, var(--menu-text) 64%, transparent);
      height: 100%;
      padding: 0 16px;
      transition: color .16s ease, background .16s ease;
    }
    .tab:hover { color: var(--menu-text); background: color-mix(in srgb, var(--menu-text) 9%, transparent); }
    .tab.active { color: var(--accent-text); background: var(--accent); }
    .page { display: none; animation: enter .2s cubic-bezier(.2,.8,.2,1); }
    .page.active { display: block; }
    @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    .head { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding: 34px 0 19px; }
    h1 { margin: 0; font-size: 29px; line-height: 1.1; letter-spacing: -.045em; font-weight: 850; }
    h2 { margin: 0; font-size: 15px; letter-spacing: -.015em; font-weight: 800; }
    p { color: var(--muted); margin: 5px 0 0; }
    .status { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); white-space: nowrap; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
    .dot.good { background: var(--good); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }
    .panel { background: var(--surface); }
    .tunnel, .usage, .activity, .models-panel { padding: 19px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
    .button {
      background: var(--raised);
      color: var(--text);
      padding: 8px 12px;
      transition: background .16s ease, color .16s ease;
    }
    .button:hover { background: color-mix(in srgb, var(--accent) 18%, var(--raised)); }
    .button.primary { background: var(--accent); color: var(--accent-text); }
    .button.primary:hover { background: var(--accent-soft); color: var(--accent-text); }
    .button.ghost { background: color-mix(in srgb, var(--raised) 68%, transparent); }
    .button.danger { color: var(--bad); }
    .button:disabled { opacity: .5; cursor: default; }
    .endpoint {
      margin-top: 15px;
      padding: 10px 12px;
      background: var(--raised);
      display: flex;
      align-items: center;
    }
    code { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .setup {
      display: none;
      margin-top: 13px;
      padding: 13px 14px;
      background: color-mix(in srgb, var(--accent) 17%, var(--strong));
    }
    .setup.show { display: flex; align-items: center; justify-content: space-between; gap: 16px; animation: enter .18s ease; }
    .provider-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }
    .provider { padding: 17px; min-height: 138px; display: flex; flex-direction: column; justify-content: space-between; gap: 18px; }
    .provider-title { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; }
    .provider-title .status { justify-self: end; }
    .account { min-height: 20px; color: var(--muted); margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .code-entry { display: none; gap: 7px; margin-top: 11px; }
    .code-entry.show { display: flex; }
    input, select {
      width: 100%;
      min-width: 0;
      background: var(--raised);
      color: var(--text);
      padding: 8px 9px;
      outline: none;
      transition: background .18s ease;
    }
    input:focus, select:focus { background: color-mix(in srgb, var(--accent) 22%, var(--raised)); }
    .usage { margin-top: 12px; }
    .usage-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .usage-total { color: var(--muted); }
    .usage-list { display: grid; gap: 12px; margin-top: 15px; }
    .usage-row { display: grid; grid-template-columns: 190px minmax(0, 1fr) 110px; align-items: center; gap: 13px; }
    .usage-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 750; }
    .usage-bar { width: 100%; height: 6px; display: block; background: var(--raised); }
    .usage-bar rect { fill: var(--accent); }
    .usage-count { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
    .activity { margin-top: 12px; }
    .activity-head, .activity-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .activity-total, .activity-note { color: var(--muted); }
    .activity-scroll { overflow-x: auto; margin-top: 15px; padding-bottom: 4px; }
    .heatmap { min-width: max-content; }
    .heatmap-months {
      display: grid;
      height: 18px;
      margin-left: 34px;
      gap: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .heatmap-months span { white-space: nowrap; }
    .heatmap-body { display: grid; grid-template-columns: 30px max-content; gap: 4px; }
    .heatmap-days {
      display: grid;
      grid-template-rows: repeat(7, 11px);
      gap: 3px;
      color: var(--muted);
      font-size: 11px;
      line-height: 11px;
    }
    .heatmap-cells {
      display: grid;
      grid-template-rows: repeat(7, 11px);
      grid-auto-flow: column;
      grid-auto-columns: 11px;
      gap: 3px;
    }
    .heat-cell { width: 11px; height: 11px; background: var(--activity-0); }
    .heat-cell.level-1 { background: var(--activity-1); }
    .heat-cell.level-2 { background: var(--activity-2); }
    .heat-cell.level-3 { background: var(--activity-3); }
    .heat-cell.level-4 { background: var(--activity-4); }
    .heat-cell.outside { opacity: 0; }
    .heat-tooltip {
      display: none;
      position: fixed;
      z-index: 5;
      padding: 6px 9px;
      background: var(--menu);
      color: var(--menu-text);
      font-size: 12px;
      white-space: nowrap;
      pointer-events: none;
    }
    .heat-tooltip.show { display: block; }
    .activity-foot { margin-top: 10px; font-size: 12px; }
    .activity-legend { display: flex; align-items: center; gap: 4px; color: var(--muted); }
    .activity-legend .heat-cell { width: 10px; height: 10px; }
    .empty { color: var(--muted); padding: 3px 0; }
    .history { margin-top: 12px; padding: 16px 19px 19px; }
    .history-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .history-count { color: var(--muted); }
    .history-list { display: grid; gap: 3px; max-height: 560px; overflow-y: auto; margin-top: 12px; }
    .history-item { background: var(--strong); }
    .history-row {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) 310px 130px;
      align-items: center;
      gap: 16px;
      min-height: 42px;
      padding: 8px 12px;
      cursor: pointer;
      list-style: none;
    }
    .history-row::-webkit-details-marker { display: none; }
    .history-item[open] .history-row { background: color-mix(in srgb, var(--accent) 9%, var(--strong)); }
    .history-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 800; }
    .history-meta, .history-tokens { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .history-meta, .history-tokens { text-align: right; }
    .history-detail { display: grid; gap: 8px; padding: 2px 12px 12px; }
    .history-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .07em; }
    .history-text {
      max-height: 260px;
      margin: 0;
      padding: 11px 12px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--surface);
      color: var(--text);
      font: 500 12px/1.5 Consolas, "Cascadia Mono", monospace;
    }
    .models-panel { padding: 10px; background: var(--surface); }
    .model-options {
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 18px;
      padding: 14px;
      background: var(--strong);
    }
    .model-option { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 12px; }
    .provider-section { padding: 16px 14px; margin-top: 8px; background: var(--strong); }
    .model-head, .model-row {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) minmax(190px, 1.3fr) 52px 48px 30px;
      gap: 8px;
      align-items: center;
    }
    .model-head { margin-top: 13px; color: var(--muted); }
    .model-row { margin-top: 8px; }
    .model-row input[type="checkbox"] { width: 16px; height: 16px; margin: auto; accent-color: var(--accent); }
    .icon-button { border: 0; background: transparent; color: var(--muted); padding: 7px; }
    .icon-button:hover { color: var(--text); }
    .icon-button.remove:hover { color: var(--bad); }
    .settings-panel { padding: 6px 10px; }
    .settings-title { padding: 18px 14px 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .09em; }
    .setting {
      display: grid;
      grid-template-columns: minmax(170px, 1fr) minmax(260px, 1.1fr);
      align-items: center;
      gap: 26px;
      padding: 14px;
      margin: 4px 0;
      background: var(--strong);
    }
    .experiment-models { display: none; }
    .experiment-models.show { display: grid; }
    .experiment-fields { display: grid; grid-template-columns: 1fr auto; gap: 7px; }
    .toggle { width: 44px; height: 24px; padding: 3px; background: var(--raised); }
    .toggle span { display: block; width: 18px; height: 18px; background: var(--muted); transition: transform .18s ease, background .18s ease; }
    .toggle.on { background: var(--accent); }
    .toggle.on span { transform: translateX(20px); background: white; }
    .error { display: none; margin-top: 13px; color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, var(--strong)); padding: 10px 12px; }
    .error.show { display: block; }
    .toast {
      position: fixed;
      right: 24px;
      bottom: 24px;
      max-width: 340px;
      padding: 10px 13px;
      color: white;
      background: #272b33;
      opacity: 0;
      transform: translateY(7px);
      pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
    }
    .toast.show { opacity: 1; transform: none; }
    .toast.bad { background: #6a1f30; }
    @media (max-width: 880px) {
      .shell { padding-inline: 19px; }
      .provider-grid { grid-template-columns: 1fr; }
      .setting { grid-template-columns: 1fr; gap: 9px; }
      .head, .setup.show { align-items: flex-start; flex-direction: column; }
      .model-head { display: none; }
      .models-panel { overflow-x: auto; }
      .model-options { grid-template-columns: 1fr; }
      .model-row { min-width: 520px; grid-template-columns: minmax(140px, 1fr) minmax(175px, 1.2fr) 48px 44px 28px; }
      .usage-row { grid-template-columns: 150px minmax(0, 1fr) 100px; }
      .history-row { grid-template-columns: minmax(0, 1fr) 110px; }
      .history-meta { display: none; }
      .experiment-fields { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <canvas id="synapses" aria-hidden="true"></canvas>
  <div class="shell">
    <header>
      <div class="brand">UNIFY</div>
      <nav>
        <button class="tab active" data-page="overview">Overview</button>
        <button class="tab" data-page="models">Models</button>
        <button class="tab" data-page="settings">Settings</button>
      </nav>
    </header>

    <section class="page active" id="overview">
      <div class="head">
        <h1>Claude and ChatGPT in Cursor.</h1>
        <div class="status"><span class="dot" id="server-dot"></span><span id="server-status">Starting gateway</span></div>
      </div>

      <div class="panel tunnel">
        <div class="row">
          <div><h2 id="tunnel-title">Quick Tunnel</h2><div class="status"><span class="dot" id="tunnel-dot"></span><span id="tunnel-status">Stopped</span></div></div>
          <div class="actions">
            <button class="button ghost" id="copy-url" hidden>Copy URL</button>
            <button class="button primary" id="tunnel-action">Start</button>
          </div>
        </div>
        <div class="endpoint" id="endpoint" hidden><code id="base-url"></code></div>
        <div class="setup" id="setup">
          <h2>Update Cursor's model settings.</h2>
          <div class="actions">
            <button class="button" id="copy-key">Copy key</button>
            <button class="button" id="open-cursor">Open Cursor Settings</button>
          </div>
        </div>
        <div class="error" id="error"></div>
      </div>

      <div class="provider-grid">
        <div class="panel provider">
          <div>
            <div class="provider-title"><h2>Claude</h2><span class="status"><span class="dot" id="claude-dot"></span><span id="claude-state">Not connected</span></span></div>
            <div class="account" id="claude-account"></div>
            <div class="code-entry" id="claude-code-row">
              <input id="claude-code" placeholder="Authorization code">
              <button class="button primary" id="submit-claude">Connect</button>
            </div>
          </div>
          <div class="actions"><button class="button" id="claude-action">Connect</button></div>
        </div>
        <div class="panel provider">
          <div>
            <div class="provider-title"><h2>ChatGPT</h2><span class="status"><span class="dot" id="chatgpt-dot"></span><span id="chatgpt-state">Not connected</span></span></div>
            <div class="account" id="chatgpt-account"></div>
          </div>
          <div class="actions"><button class="button" id="chatgpt-action">Connect</button></div>
        </div>
      </div>

      <div class="panel usage">
        <div class="usage-head"><h2>Usage · 30 days</h2><span class="usage-total" id="usage-total">0 tokens</span></div>
        <div class="usage-list" id="usage-list"></div>
      </div>

      <div class="panel activity">
        <div class="activity-head"><h2 id="activity-title">0 prompts in the last year</h2><span class="activity-total" id="activity-total">365 days</span></div>
        <div class="activity-scroll"><div class="heatmap" id="prompt-heatmap"></div></div>
        <div class="activity-foot">
          <span class="activity-note">Completed requests only</span>
          <div class="activity-legend" id="activity-legend"><span>Less</span><span class="heat-cell"></span><span class="heat-cell level-1"></span><span class="heat-cell level-2"></span><span class="heat-cell level-3"></span><span class="heat-cell level-4"></span><span>More</span></div>
        </div>
      </div>

      <div class="panel history">
        <div class="history-head"><h2>Prompt history</h2><span class="history-count" id="history-count">0 / 10 · Local only</span></div>
        <div class="history-list" id="history-list"></div>
      </div>
    </section>

    <section class="page" id="models">
      <div class="head">
        <h1>Models</h1>
        <div class="actions">
          <button class="button ghost" id="copy-models">Copy names</button>
          <button class="button primary" id="save-models">Save</button>
        </div>
      </div>
      <div class="panel models-panel">
        <div class="model-options">
          <label class="model-option"><h2>Effort</h2><select id="reasoning"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option><option value="max">Max</option></select></label>
          <label class="model-option"><h2>Speed</h2><select id="speed"><option value="standard">Standard</option><option value="fast">Fast</option></select></label>
        </div>
        <div class="provider-section">
          <div class="row"><h2>Claude</h2><button class="button ghost add-model" data-provider="claude">Add model</button></div>
          <div class="model-head"><span>Cursor name</span><span>Backend ID</span><span>Shown</span><span></span><span></span></div>
          <div id="claude-models"></div>
        </div>
        <div class="provider-section">
          <div class="row"><h2>OpenAI</h2><button class="button ghost add-model" data-provider="chatgpt">Add model</button></div>
          <div class="model-head"><span>Cursor name</span><span>Backend ID</span><span>Shown</span><span></span><span></span></div>
          <div id="chatgpt-models"></div>
        </div>
      </div>
    </section>

    <section class="page" id="settings">
      <div class="head"><h1>Settings</h1></div>
      <div class="panel settings-panel">
        <div class="setting">
          <h2>Theme</h2>
          <select id="theme"><option value="default">Default</option><option value="dark">Carbon</option><option value="incognito">Incognito</option><option value="aquamint">Aquamint</option><option value="sophisticated">Sophisticated</option><option value="violet">Wock</option><option value="honeycomb">Honeycomb</option><option value="skid">Skid</option><option value="light">Light</option></select>
        </div>
        <div class="setting">
          <h2>Floating synapses</h2>
          <div><button class="toggle on" id="synapses-toggle" aria-label="Toggle floating synapses" aria-pressed="true"><span></span></button></div>
        </div>
        <div class="setting">
          <h2>Tunnel startup</h2>
          <select id="tunnel-mode">
            <option value="manual">No automatic tunneling</option>
            <option value="prompt">Prompted tunneling</option>
            <option value="automatic">Fully automatic tunneling</option>
          </select>
        </div>
        <div class="setting">
          <h2>Cursor URL</h2>
          <select id="cursor-url-mode">
            <option value="prompt">Prompt to restart</option>
            <option value="automatic">Restart automatically</option>
          </select>
        </div>
        <div class="setting">
          <h2>Bridge key</h2>
          <div><button class="button danger" id="rotate-key">Rotate key</button></div>
        </div>
        <h2 class="settings-title">Experiments</h2>
        <div class="setting">
          <div><h2>Local Mode</h2><p>Try the loopback gateway without Cloudflare.</p></div>
          <div><button class="toggle" id="local-mode-toggle" aria-label="Toggle Local Mode" aria-pressed="false"><span></span></button></div>
        </div>
        <div class="setting">
          <div><h2>Deep Prompt</h2><p>Validate final text after tools finish.</p></div>
          <div><button class="toggle" id="deep-prompt-toggle" aria-label="Toggle Deep Prompt" aria-pressed="false"><span></span></button></div>
        </div>
        <div class="setting experiment-models" id="deep-prompt-models">
          <h2>Validator model</h2>
          <div class="experiment-fields">
            <input id="deep-prompt-validator" placeholder="Validator model · Sol">
            <button class="button primary" id="save-experiments">Save</button>
          </div>
        </div>
      </div>
    </section>
  </div>
  <div class="heat-tooltip" id="heat-tooltip"></div>
  <div class="toast" id="toast"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    let state;
    let draftModels = [];
    let modelsDirty = false;
    let experimentsDirty = false;
    let experimentsSaving = false;
    let usageSignature = "";
    let promptSignature = "";
    let historySignature = "";
    let toastTimer;
    let synapseFrame = 0;
    let synapseNodes = [];
    const synapseCanvas = $("synapses");
    const synapseContext = synapseCanvas.getContext("2d");
    const post = (value) => vscode.postMessage(value);
    const setInput = (id, value) => { if (document.activeElement !== $(id)) $(id).value = value == null ? "" : value; };
    const setDot = (id, value) => { $(id).className = "dot " + value; };
    const tokenText = (value) => new Intl.NumberFormat().format(value) + " tokens";
    const toast = (message, bad) => {
      clearTimeout(toastTimer);
      $("toast").textContent = message;
      $("toast").className = "toast show" + (bad ? " bad" : "");
      toastTimer = setTimeout(() => $("toast").className = "toast", 2600);
    };

    document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll(".tab,.page").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $(button.dataset.page).classList.add("active");
    }));
    $("tunnel-action").addEventListener("click", () => post({ type: "tunnel", action: state && state.tunnel.status === "running" ? "stop" : "start" }));
    $("copy-url").addEventListener("click", () => post({ type: "copy", value: "baseUrl" }));
    $("copy-key").addEventListener("click", () => post({ type: "copy", value: "key" }));
    $("open-cursor").addEventListener("click", () => post({ type: "openCursorSettings" }));
    $("claude-action").addEventListener("click", () => post({ type: "auth", provider: "claude", action: state && state.auth.claude.connected ? "disconnect" : "connect" }));
    $("chatgpt-action").addEventListener("click", () => post({ type: "auth", provider: "chatgpt", action: state && state.auth.chatgpt.connected ? "disconnect" : "connect" }));
    $("submit-claude").addEventListener("click", () => post({ type: "claudeCode", code: $("claude-code").value }));
    $("tunnel-mode").addEventListener("change", (event) => post({ type: "settings", values: { tunnelMode: event.target.value } }));
    $("cursor-url-mode").addEventListener("change", (event) => post({ type: "settings", values: { cursorUrlMode: event.target.value } }));
    $("theme").addEventListener("change", (event) => {
      document.documentElement.dataset.theme = event.target.value;
      post({ type: "settings", values: { theme: event.target.value } });
    });
    $("synapses-toggle").addEventListener("click", () => {
      const enabled = !$("synapses-toggle").classList.contains("on");
      if (state) state.settings.synapses = enabled;
      setSynapses(enabled);
      post({ type: "settings", values: { synapses: enabled } });
    });
    $("reasoning").addEventListener("change", () => { modelsDirty = true; });
    $("speed").addEventListener("change", () => { modelsDirty = true; });
    $("rotate-key").addEventListener("click", () => post({ type: "rotateKey" }));
    $("local-mode-toggle").addEventListener("click", () => {
      const enabled = !$("local-mode-toggle").classList.contains("on");
      $("local-mode-toggle").classList.toggle("on", enabled);
      $("local-mode-toggle").setAttribute("aria-pressed", String(enabled));
      post({ type: "settings", values: { localMode: enabled } });
    });
    $("deep-prompt-toggle").addEventListener("click", () => {
      const enabled = !$("deep-prompt-toggle").classList.contains("on");
      $("deep-prompt-toggle").classList.toggle("on", enabled);
      $("deep-prompt-toggle").setAttribute("aria-pressed", String(enabled));
      $("deep-prompt-models").classList.toggle("show", enabled);
      experimentsSaving = true;
      post({ type: "settings", values: {
        deepPrompt: enabled,
        deepPromptValidator: $("deep-prompt-validator").value
      } });
    });
    $("deep-prompt-validator").addEventListener("input", () => { experimentsDirty = true; });
    $("save-experiments").addEventListener("click", () => {
      experimentsSaving = true;
      post({ type: "settings", values: {
        deepPrompt: $("deep-prompt-toggle").classList.contains("on"),
        deepPromptValidator: $("deep-prompt-validator").value
      } });
    });
    $("save-models").addEventListener("click", () => {
      post({ type: "settings", values: { models: draftModels, reasoning: $("reasoning").value, speed: $("speed").value } });
    });
    $("copy-models").addEventListener("click", () => post({ type: "copy", value: "models" }));
    document.querySelectorAll(".add-model").forEach((button) => button.addEventListener("click", () => {
      draftModels.push({
        provider: button.dataset.provider,
        frontend: "",
        backend: "",
        enabled: true
      });
      modelsDirty = true;
      renderModels();
    }));

    function modelInput(type, value, index) {
      const input = document.createElement("input");
      if (type === "enabled") {
        input.type = "checkbox";
        input.checked = value;
      } else {
        input.value = value;
        input.placeholder = type === "frontend" ? "Cursor name" : "Backend ID";
      }
      input.addEventListener(type === "frontend" || type === "backend" ? "input" : "change", () => {
        draftModels[index][type] = type === "enabled" ? input.checked : input.value;
        modelsDirty = true;
      });
      return input;
    }

    function renderModels() {
      for (const provider of ["claude", "chatgpt"]) {
        const root = $(provider + "-models");
        root.replaceChildren();
        draftModels.forEach((model, index) => {
          if (model.provider !== provider) return;
          const row = document.createElement("div");
          row.className = "model-row";
          row.append(modelInput("frontend", model.frontend, index));
          row.append(modelInput("backend", model.backend, index));
          row.append(modelInput("enabled", model.enabled, index));
          const copy = document.createElement("button");
          copy.className = "icon-button";
          copy.textContent = "Copy";
          copy.addEventListener("click", () => post({ type: "copy", value: "model:" + model.frontend }));
          row.append(copy);
          const remove = document.createElement("button");
          remove.className = "icon-button remove";
          remove.textContent = "×";
          remove.title = "Remove";
          remove.addEventListener("click", () => {
            draftModels.splice(index, 1);
            modelsDirty = true;
            renderModels();
          });
          row.append(remove);
          root.append(row);
        });
      }
    }

    function renderUsage(points) {
      const cutoff = new Date();
      cutoff.setUTCDate(cutoff.getUTCDate() - 29);
      const cutoffDay = cutoff.toISOString().slice(0, 10);
      const totals = new Map();
      points.filter((point) => point.day >= cutoffDay).forEach((point) => totals.set(point.model, (totals.get(point.model) || 0) + point.input + point.output));
      const rows = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
      const signature = JSON.stringify(rows);
      if (signature === usageSignature) return;
      usageSignature = signature;
      const total = rows.reduce((sum, item) => sum + item[1], 0);
      const max = rows.length ? rows[0][1] : 1;
      $("usage-total").textContent = tokenText(total);
      $("usage-list").replaceChildren();
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Usage appears after the first completed request.";
        $("usage-list").append(empty);
        return;
      }
      rows.forEach(([name, count]) => {
        const row = document.createElement("div");
        row.className = "usage-row";
        const label = document.createElement("span");
        label.className = "usage-name";
        label.textContent = name;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "usage-bar");
        svg.setAttribute("viewBox", "0 0 100 6");
        svg.setAttribute("preserveAspectRatio", "none");
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("height", "6");
        rect.setAttribute("width", String(Math.max(1, count / max * 100)));
        svg.append(rect);
        const value = document.createElement("span");
        value.className = "usage-count";
        value.textContent = tokenText(count);
        row.append(label, svg, value);
        $("usage-list").append(row);
      });
    }

    function renderPrompts(points) {
      const dayMs = 86400000;
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const firstDay = new Date(todayUtc.getTime() - 364 * dayMs);
      const gridStart = new Date(firstDay);
      gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
      const weeks = Math.floor((todayUtc.getTime() - gridStart.getTime()) / (7 * dayMs)) + 1;
      const firstIso = firstDay.toISOString().slice(0, 10);
      const todayIso = todayUtc.toISOString().slice(0, 10);
      const counts = new Map();
      points.forEach((point) => {
        if (point.day >= firstIso && point.day <= todayIso) {
          counts.set(point.day, (counts.get(point.day) || 0) + (point.prompts || 0));
        }
      });
      const signature = JSON.stringify([todayIso, Array.from(counts.entries()).sort()]);
      if (signature === promptSignature) return;
      promptSignature = signature;

      const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
      const max = Math.max(1, ...counts.values());
      $("activity-title").textContent = new Intl.NumberFormat().format(total) + (total === 1 ? " prompt" : " prompts") + " in the last year";

      const root = $("prompt-heatmap");
      root.replaceChildren();
      const months = document.createElement("div");
      months.className = "heatmap-months";
      months.style.gridTemplateColumns = "repeat(" + weeks + ", 11px)";
      let previousMonth = -1;
      for (let week = 0; week < weeks; week += 1) {
        const date = new Date(gridStart.getTime() + week * 7 * dayMs);
        const month = date.getUTCMonth();
        if (week === 0 || month !== previousMonth) {
          const label = document.createElement("span");
          label.style.gridColumn = String(week + 1);
          label.textContent = date.toLocaleString(undefined, { month: "short", timeZone: "UTC" });
          months.append(label);
        }
        previousMonth = month;
      }

      const body = document.createElement("div");
      body.className = "heatmap-body";
      const days = document.createElement("div");
      days.className = "heatmap-days";
      ["", "Mon", "", "Wed", "", "Fri", ""].forEach((value) => {
        const label = document.createElement("span");
        label.textContent = value;
        days.append(label);
      });
      const cells = document.createElement("div");
      cells.className = "heatmap-cells";
      cells.setAttribute("role", "img");
      cells.setAttribute("aria-label", total + " completed prompts in the last year");
      for (let week = 0; week < weeks; week += 1) {
        for (let weekday = 0; weekday < 7; weekday += 1) {
          const date = new Date(gridStart.getTime() + (week * 7 + weekday) * dayMs);
          const iso = date.toISOString().slice(0, 10);
          const count = counts.get(iso) || 0;
          const level = count ? Math.min(4, Math.ceil(count / max * 4)) : 0;
          const cell = document.createElement("span");
          cell.className = "heat-cell level-" + level + (iso < firstIso || iso > todayIso ? " outside" : "");
          if (iso >= firstIso && iso <= todayIso) {
            const label = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
              + " · " + count + (count === 1 ? " prompt" : " prompts");
            cell.setAttribute("aria-label", label);
            cell.addEventListener("mouseenter", () => {
              $("heat-tooltip").textContent = label;
              $("heat-tooltip").classList.add("show");
            });
            cell.addEventListener("mousemove", (event) => {
              const tip = $("heat-tooltip");
              tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, event.clientX + 12) + "px";
              tip.style.top = Math.min(innerHeight - tip.offsetHeight - 8, event.clientY + 12) + "px";
            });
            cell.addEventListener("mouseleave", () => $("heat-tooltip").classList.remove("show"));
          }
          cells.append(cell);
        }
      }
      body.append(days, cells);
      root.append(months, body);
    }

    function renderHistory(items) {
      items = items.slice(0, 10);
      const signature = JSON.stringify(items);
      if (signature === historySignature) return;
      historySignature = signature;
      $("history-count").textContent = new Intl.NumberFormat().format(items.length) + " / 10 · Local only";
      const root = $("history-list");
      root.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Request history appears after the next completed prompt.";
        root.append(empty);
        return;
      }
      const format = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
      items.forEach((item) => {
        const entry = document.createElement("details");
        entry.className = "history-item";
        const row = document.createElement("summary");
        row.className = "history-row";
        const model = document.createElement("span");
        model.className = "history-model";
        const effort = item.effort === "xhigh" ? "XHigh" : item.effort ? item.effort[0].toUpperCase() + item.effort.slice(1) : null;
        const speed = item.speed ? item.speed[0].toUpperCase() + item.speed.slice(1) : null;
        model.textContent = [item.model, effort, speed].filter(Boolean).join(" · ");
        const meta = document.createElement("span");
        meta.className = "history-meta";
        meta.textContent = (item.provider === "chatgpt" ? "OpenAI" : "Claude") + " · " + format.format(item.time);
        const tokens = document.createElement("span");
        tokens.className = "history-tokens";
        tokens.textContent = tokenText(item.input + item.output);
        row.append(model, meta, tokens);
        const detail = document.createElement("div");
        detail.className = "history-detail";
        [["Prompt", item.prompt], ["Result", item.result]].forEach(([label, value]) => {
          const title = document.createElement("div");
          title.className = "history-label";
          title.textContent = label;
          const text = document.createElement("pre");
          text.className = "history-text";
          text.textContent = value || "Not captured for this older request.";
          detail.append(title, text);
        });
        entry.append(row, detail);
        root.append(entry);
      });
    }

    function sizeSynapses() {
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      synapseCanvas.width = Math.floor(innerWidth * scale);
      synapseCanvas.height = Math.floor(innerHeight * scale);
      synapseContext.setTransform(scale, 0, 0, scale, 0, 0);
      const count = Math.min(80, Math.max(34, Math.floor(innerWidth * innerHeight / 26000)));
      synapseNodes = Array.from({ length: count }, () => ({
        x: Math.random() * innerWidth,
        y: Math.random() * innerHeight,
        dx: (Math.random() - .5) * .17,
        dy: (Math.random() - .5) * .17
      }));
    }

    function drawSynapses() {
      if (!state || !state.settings.synapses) {
        synapseFrame = 0;
        return;
      }
      synapseContext.clearRect(0, 0, innerWidth, innerHeight);
      const rgb = getComputedStyle(document.documentElement).getPropertyValue("--synapse").trim();
      synapseNodes.forEach((node, index) => {
        node.x += node.dx;
        node.y += node.dy;
        if (node.x < 0 || node.x > innerWidth) node.dx *= -1;
        if (node.y < 0 || node.y > innerHeight) node.dy *= -1;
        synapseContext.fillStyle = "rgba(" + rgb + ",.46)";
        synapseContext.fillRect(node.x, node.y, 3.5, 3.5);
        for (let next = index + 1; next < synapseNodes.length; next += 1) {
          const other = synapseNodes[next];
          const distance = Math.hypot(node.x - other.x, node.y - other.y);
          if (distance >= 185) continue;
          synapseContext.strokeStyle = "rgba(" + rgb + "," + (.2 * (1 - distance / 185)) + ")";
          synapseContext.beginPath();
          synapseContext.moveTo(node.x, node.y);
          synapseContext.lineTo(other.x, other.y);
          synapseContext.stroke();
        }
      });
      synapseFrame = requestAnimationFrame(drawSynapses);
    }

    function setSynapses(enabled) {
      $("synapses-toggle").classList.toggle("on", enabled);
      $("synapses-toggle").setAttribute("aria-pressed", String(enabled));
      synapseCanvas.hidden = !enabled;
      if (!enabled && synapseFrame) cancelAnimationFrame(synapseFrame);
      if (!enabled) {
        synapseFrame = 0;
        synapseContext.clearRect(0, 0, innerWidth, innerHeight);
      } else if (!synapseFrame) {
        sizeSynapses();
        drawSynapses();
      }
    }

    window.addEventListener("resize", () => {
      if (state && state.settings.synapses) sizeSynapses();
    });

    function render(next) {
      state = next;
      document.documentElement.dataset.theme = next.settings.theme;
      setInput("theme", next.settings.theme);
      setSynapses(next.settings.synapses);
      $("server-status").textContent = next.serverReady ? "Gateway ready" : "Gateway unavailable";
      setDot("server-dot", next.serverReady ? "good" : "bad");

      const local = next.settings.localMode;
      const running = next.tunnel.status === "running";
      const busy = next.tunnel.status === "starting" || next.tunnel.status === "installing";
      const labels = { stopped: "Stopped", installing: "Installing", starting: "Starting", running: next.tunnel.reused ? "Running · persistent" : "Running", error: "Error" };
      $("tunnel-title").textContent = local ? "Local Gateway" : "Quick Tunnel";
      $("tunnel-status").textContent = local && running ? "Running · experimental" : labels[next.tunnel.status] || next.tunnel.status;
      setDot("tunnel-dot", running ? "good" : busy ? "warn" : next.tunnel.status === "error" ? "bad" : "");
      $("tunnel-action").textContent = running ? "Stop" : busy ? "Starting…" : "Start";
      $("tunnel-action").disabled = busy;
      $("tunnel-action").hidden = local;
      $("copy-url").hidden = !running;
      $("endpoint").hidden = !running;
      $("base-url").textContent = next.tunnel.baseUrl || "";
      $("setup").classList.toggle("show", Boolean(next.setupNeeded && running));
      $("error").textContent = next.error || next.tunnel.error || "";
      $("error").classList.toggle("show", Boolean(next.error || next.tunnel.error));

      for (const provider of ["claude", "chatgpt"]) {
        const value = next.auth[provider];
        $(provider + "-state").textContent = value.connected ? "Connected" : value.pending ? "Waiting" : "Not connected";
        $(provider + "-account").textContent = value.email || "";
        setDot(provider + "-dot", value.connected ? "good" : value.pending ? "warn" : "");
        $(provider + "-action").textContent = value.connected ? "Disconnect" : value.pending ? "Open sign-in" : "Connect";
      }
      $("claude-code-row").classList.toggle("show", Boolean(next.auth.claude.pending && !next.auth.claude.connected));
      setInput("tunnel-mode", next.settings.tunnelMode);
      setInput("cursor-url-mode", next.settings.cursorUrlMode);
      $("local-mode-toggle").classList.toggle("on", next.settings.localMode);
      $("local-mode-toggle").setAttribute("aria-pressed", String(next.settings.localMode));
      if (!experimentsDirty) {
        setInput("deep-prompt-validator", next.settings.deepPromptValidator);
        $("deep-prompt-toggle").classList.toggle("on", next.settings.deepPrompt);
        $("deep-prompt-toggle").setAttribute("aria-pressed", String(next.settings.deepPrompt));
        $("deep-prompt-models").classList.toggle("show", next.settings.deepPrompt);
      }
      if (!modelsDirty) {
        setInput("reasoning", next.settings.reasoning);
        setInput("speed", next.settings.speed);
        draftModels = next.settings.models.map((model) => ({ ...model }));
        renderModels();
      }
      renderUsage(next.usage);
      renderPrompts(next.usage);
      renderHistory(next.history);
    }

    window.addEventListener("message", ({ data }) => {
      if (data.type === "state") render(data.value);
      if (data.type === "notice") {
        if (!data.error && data.message === "Saved.") modelsDirty = false;
        if (!data.error && data.message === "Saved." && experimentsSaving) {
          experimentsDirty = false;
          experimentsSaving = false;
        }
        if (data.error) experimentsSaving = false;
        toast(data.message, data.error);
      }
    });
    post({ type: "ready" });
  </script>
</body>
</html>`;
}
