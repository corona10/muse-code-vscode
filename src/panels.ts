import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { ChatController, ControllerDeps } from "./chatController";

export const PANEL_VIEW_TYPE = "museVSCodePanel";
export const SIDEBAR_VIEW_IDS = ["museVSCodeSidebar", "museVSCodeSidebarSecondary"] as const;

interface PanelState {
  workspaceRoot: string;
  sessionId: string | null;
}

export function getWebviewHtml(webview: vscode.Webview, extUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "dist", "webview.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "webview.css"));
  const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extUri, "media", "codicon.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codicons}">
<link rel="stylesheet" href="${style}">
<title>Muse Code</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** A chat tab in the editor area. */
export class MusePanel implements vscode.Disposable {
  readonly controller: ChatController;
  private customTitle: string | null = null;
  private unread = false;
  private disposables: vscode.Disposable[] = [];

  constructor(readonly panel: vscode.WebviewPanel, private readonly deps: ControllerDeps, readonly workspaceRoot: string, private readonly onDispose: (p: MusePanel) => void) {
    this.controller = new ChatController({ ...deps, location: "panel" }, workspaceRoot, {
      onTitle: (t) => this.updateTitle(t),
      onRunning: (r) => this.setIcon(r ? "pending" : null),
      onTurnCompleted: () => {
        if (!panel.active) this.markUnread();
      },
    });
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(deps.ctx.extensionUri, "dist"), vscode.Uri.joinPath(deps.ctx.extensionUri, "media")] };
    panel.webview.html = getWebviewHtml(panel.webview, deps.ctx.extensionUri);
    this.controller.attach(panel.webview);
    this.disposables.push(
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.unread = false;
          this.setIcon(this.controller.conversation.state.meta.running ? "pending" : null);
        }
      }),
      panel.onDidDispose(() => {
        this.onDispose(this);
        this.dispose();
      }),
    );
    this.setIcon(null);
  }

  private updateTitle(t: string | null) {
    this.panel.title = this.customTitle ?? (t ? `Muse: ${t}` : "Muse Code");
  }

  rename(title: string) {
    this.customTitle = title;
    this.panel.title = title;
  }

  markUnread() {
    this.unread = true;
    this.setIcon("done");
  }

  private setIcon(kind: "pending" | "done" | null) {
    const name = kind === "pending" ? "muse-logo-pending.svg" : kind === "done" || this.unread ? "muse-logo-done.svg" : "muse-logo.svg";
    this.panel.iconPath = vscode.Uri.joinPath(this.deps.ctx.extensionUri, "resources", name);
  }

  reveal() {
    this.panel.reveal(undefined, false);
  }

  dispose() {
    this.controller.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

export class PanelManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private panels: MusePanel[] = [];
  private lastActive: MusePanel | null = null;
  private lastClosed: PanelState | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  get active(): MusePanel | undefined {
    return this.panels.find((p) => p.panel.active) ?? (this.lastActive && this.panels.includes(this.lastActive) ? this.lastActive : undefined);
  }

  get all(): readonly MusePanel[] {
    return this.panels;
  }

  async open(workspaceRoot: string, opts: { resumeSessionId?: string; column?: vscode.ViewColumn } = {}): Promise<MusePanel> {
    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, "Muse Code", { viewColumn: opts.column ?? vscode.ViewColumn.Beside, preserveFocus: false }, { enableScripts: true, retainContextWhenHidden: true });
    return this.adopt(panel, workspaceRoot, opts.resumeSessionId);
  }

  private async adopt(panel: vscode.WebviewPanel, workspaceRoot: string, resumeSessionId?: string): Promise<MusePanel> {
    const mp = new MusePanel(panel, this.deps, workspaceRoot, (p) => this.onClosed(p));
    this.panels.push(mp);
    this.lastActive = mp;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.lastActive = mp;
    });
    if (resumeSessionId) await mp.controller.resume(resumeSessionId);
    else await mp.controller.newConversation();
    return mp;
  }

  private onClosed(p: MusePanel) {
    this.panels = this.panels.filter((x) => x !== p);
    this.lastClosed = { workspaceRoot: p.workspaceRoot, sessionId: p.controller.sessionId };
    void vscode.commands.executeCommand("setContext", "muse-vscode.lastClosedWasSession", !!this.lastClosed.sessionId);
  }

  async reopenClosed(): Promise<boolean> {
    const s = this.lastClosed;
    if (!s?.sessionId) return false;
    this.lastClosed = null;
    void vscode.commands.executeCommand("setContext", "muse-vscode.lastClosedWasSession", false);
    await this.open(s.workspaceRoot, { resumeSessionId: s.sessionId });
    return true;
  }

  /** Reveal the most recent tab or open a new one. */
  async openLast(workspaceRoot: string): Promise<MusePanel> {
    const p = this.active ?? this.panels[this.panels.length - 1];
    if (p) {
      p.reveal();
      return p;
    }
    return this.open(workspaceRoot);
  }

  /** The webview persists `{ panelState: { workspaceRoot, sessionId } }` via setState; restore from it after a reload. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { panelState?: PanelState } | undefined): Promise<void> {
    const ps = state?.panelState;
    const root = ps?.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      panel.dispose();
      return;
    }
    await this.adopt(panel, root, ps?.sessionId ?? undefined);
  }

  dispose() {
    for (const p of [...this.panels]) p.panel.dispose();
  }
}

/** The side bar chat (primary activity bar or secondary side bar depending on VS Code version). */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | null = null;
  controller: ChatController | null = null;
  private pendingResume: string | null = null;

  constructor(private readonly deps: ControllerDeps, private readonly resolveRoot: () => Promise<string | undefined>) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const root = await this.resolveRoot();
    if (!root) return;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.deps.ctx.extensionUri, "dist"), vscode.Uri.joinPath(this.deps.ctx.extensionUri, "media")] };
    view.webview.html = getWebviewHtml(view.webview, this.deps.ctx.extensionUri);
    this.controller?.dispose();
    this.controller = new ChatController({ ...this.deps, location: "sidebar" }, root, {
      onTitle: (t) => (view.description = t ?? undefined),
    });
    this.controller.attach(view.webview);
    view.onDidChangeVisibility(() => {
      void vscode.commands.executeCommand("setContext", "muse-vscode.sideBarActive", view.visible);
      if (view.visible) this.controller?.sync();
    });
    view.onDidDispose(() => {
      this.controller?.dispose();
      this.controller = null;
      this.view = null;
      void vscode.commands.executeCommand("setContext", "muse-vscode.sideBarActive", false);
    });
    void vscode.commands.executeCommand("setContext", "muse-vscode.sideBarActive", view.visible);
    if (this.pendingResume) {
      const sid = this.pendingResume;
      this.pendingResume = null;
      await this.controller.resume(sid);
    } else await this.controller.newConversation();
  }

  async reveal(resumeSessionId?: string) {
    if (resumeSessionId) {
      if (this.controller) await this.controller.resume(resumeSessionId);
      else this.pendingResume = resumeSessionId;
    }
    for (const id of SIDEBAR_VIEW_IDS) {
      try {
        await vscode.commands.executeCommand(`${id}.focus`);
        break;
      } catch {
        /* view not registered under this id */
      }
    }
    this.view?.show?.(false);
  }

  get visible() {
    return !!this.view?.visible;
  }

  dispose() {
    this.controller?.dispose();
  }
}
