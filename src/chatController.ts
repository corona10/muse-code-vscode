import * as vscode from "vscode";
import { Conversation } from "./conversation";
import { EditorContextService } from "./editorContext";
import { HostManager } from "./hosts";
import type { ApprovalMode, ReasoningEffort } from "./msp/msp";
import type { EditorContext, FromWebview, SendPayload, ToWebview, UiConfig } from "./protocol";
import { turnInputFromPayload } from "./protocol";

export interface ControllerDeps {
  ctx: vscode.ExtensionContext;
  hosts: HostManager;
  editor: EditorContextService;
  log: (l: string) => void;
  location: "panel" | "sidebar";
}

export interface ControllerEvents {
  onTitle?: (title: string | null) => void;
  onRunning?: (running: boolean) => void;
  onTurnCompleted?: () => void;
}

const HISTORY_KEY = "muse-vscode.promptHistory";

/** Bridges one webview to one Conversation plus the VS Code services the chat needs. */
export class ChatController implements vscode.Disposable {
  conversation: Conversation;
  private webview: vscode.Webview | null = null;
  private disposables: vscode.Disposable[] = [];
  private ready = false;

  constructor(private readonly deps: ControllerDeps, readonly workspaceRoot: string, private events: ControllerEvents = {}) {
    this.conversation = this.createConversation();
    this.disposables.push(
      deps.editor.onDidChange((ctx) => this.post({ type: "editorContext", ctx })),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("museCode")) this.post({ type: "config", config: this.config() });
      }),
    );
  }

  private createConversation(): Conversation {
    const cfg = vscode.workspace.getConfiguration("museCode");
    const requested = cfg.get<string>("initialApprovalMode") as ApprovalMode | undefined;
    const approvalMode = requested === "allowAll" && !cfg.get<boolean>("allowDangerouslyAllowAll", false) ? undefined : requested;
    const conv = new Conversation(this.deps.hosts.get(this.workspaceRoot), this.workspaceRoot, {
      approvalMode: approvalMode || null,
      modelId: cfg.get<string>("model") || undefined,
      reasoningEffort: (cfg.get<string>("reasoningEffort") as ReasoningEffort | undefined) || null,
    });
    conv.on("message", (m: ToWebview) => {
      this.post(m);
      if (m.type === "meta" || m.type === "state") {
        const meta = m.type === "meta" ? m.meta : m.state.meta;
        if (meta.title !== undefined) this.events.onTitle?.(meta.title ?? null);
        if (meta.running !== undefined) this.events.onRunning?.(!!meta.running);
      }
    });
    conv.on("turnCompleted", () => this.events.onTurnCompleted?.());
    conv.on("log", (l: string) => this.deps.log(l));
    return conv;
  }

  get sessionId() {
    return this.conversation.sessionId;
  }

  config(): UiConfig {
    const cfg = vscode.workspace.getConfiguration("museCode");
    return {
      focusView: cfg.get<boolean>("focusView", false),
      useCtrlEnterToSend: cfg.get<boolean>("useCtrlEnterToSend", false),
      hideOnboarding: cfg.get<boolean>("hideOnboarding", false),
      includeEditorContext: cfg.get<boolean>("includeEditorContext", true),
      allowAllEnabled: cfg.get<boolean>("allowDangerouslyAllowAll", false),
      userShell: this.conversation.host.userShellGranted,
      location: this.deps.location,
    };
  }

  attach(webview: vscode.Webview) {
    this.webview = webview;
    this.disposables.push(webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m)));
  }

  post(msg: ToWebview) {
    if (this.webview && this.ready) void this.webview.postMessage(msg);
  }

  /** Full re-sync, used on ready and when a view becomes visible again. */
  sync() {
    this.ready = true;
    this.post({ type: "init", config: this.config(), state: this.conversation.state });
    this.post({ type: "editorContext", ctx: this.deps.editor.current() });
  }

  focusInput() {
    this.post({ type: "focusInput" });
  }
  blurInput() {
    this.post({ type: "blurInput" });
  }
  insertText(text: string) {
    this.post({ type: "insertText", text });
  }

  async newConversation() {
    const old = this.conversation;
    old.dispose();
    this.conversation = this.createConversation();
    this.events.onTitle?.(null);
    try {
      await this.conversation.startNew();
      this.post({ type: "config", config: this.config() });
    } catch (e) {
      this.reportError(e);
      this.post({ type: "state", state: this.conversation.state });
    }
  }

  async resume(sessionId: string) {
    const old = this.conversation;
    old.dispose();
    this.conversation = this.createConversation();
    try {
      await this.conversation.resume(sessionId);
      this.post({ type: "config", config: this.config() });
    } catch (e) {
      this.reportError(e);
      this.post({ type: "state", state: this.conversation.state });
    }
  }

  private reportError(e: unknown) {
    const msg = this.conversation.describeError(e);
    this.deps.log(`error: ${msg}`);
    const host = this.conversation.host;
    const cfg = vscode.workspace.getConfiguration("museCode");
    const authy = host.looksLikeAuthFailure(msg) || host.looksLikeAuthFailure(host.statusMessage);
    this.conversation.toast("error", host.status === "failed" && host.statusMessage ? host.statusMessage : msg, authy && !cfg.get("disableLoginPrompt") ? { label: "Login", command: "muse-vscode.login" } : { label: "Show logs", command: "muse-vscode.showLogs" });
  }

  private async handle(m: FromWebview) {
    try {
      switch (m.type) {
        case "ready":
          this.sync();
          break;
        case "send":
          await this.sendPrompt(m.payload);
          break;
        case "interrupt":
          await this.conversation.interrupt(false);
          break;
        case "unqueue":
          await this.conversation.unqueue(m.turnId);
          break;
        case "decideApproval":
          await this.conversation.decideApproval(m.approvalId, m.choiceId, m.requirementId, m.feedback);
          break;
        case "answerUserInput":
          await this.conversation.answerUserInput(m.userInputId, m.answers);
          break;
        case "cancelUserInput":
          await this.conversation.cancelUserInput(m.userInputId);
          break;
        case "newConversation":
          await this.newConversation();
          break;
        case "listSessions":
          this.post({ type: "sessions", sessions: await this.conversation.listSessions() });
          break;
        case "resumeSession":
          await this.resume(m.sessionId);
          break;
        case "listModels":
          this.post({ type: "models", models: await this.conversation.listModels() });
          break;
        case "setModel":
          await this.conversation.setModel(m.modelId);
          break;
        case "setApprovalMode":
          if (m.mode === "allowAll" && !this.config().allowAllEnabled) {
            this.conversation.toast("warning", "Enable museCode.allowDangerouslyAllowAll to use the Allow all mode.");
            break;
          }
          await this.conversation.setApprovalMode(m.mode);
          break;
        case "setReasoningEffort":
          this.conversation.setReasoningEffort(m.effort);
          break;
        case "compact":
          await this.conversation.compact();
          this.conversation.toast("info", "Compaction requested.");
          break;
        case "runShell":
          if (!this.conversation.host.userShellGranted) {
            this.conversation.toast("warning", "This Muse host did not grant the userShell capability.");
            break;
          }
          await this.conversation.runShell(m.command);
          break;
        case "openFile":
          await this.deps.editor.openFile(this.workspaceRoot, m.path, m.line);
          break;
        case "openDiff":
          await this.deps.editor.openDiff(this.workspaceRoot, m.path);
          break;
        case "pickFile": {
          const cfg = vscode.workspace.getConfiguration("museCode");
          const f = await this.deps.editor.pickFileForMention(this.workspaceRoot, cfg.get<boolean>("respectGitIgnore", true));
          if (f) this.insertText(`@${f} `);
          this.focusInput();
          break;
        }
        case "toggleFocusView":
          await vscode.commands.executeCommand("muse-vscode.toggleFocusView");
          break;
        case "setConfig":
          await vscode.workspace.getConfiguration("museCode").update(m.key, m.value, vscode.ConfigurationTarget.Global);
          break;
        case "command":
          await vscode.commands.executeCommand(m.command);
          break;
        case "openExternal":
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
        case "copy":
          await vscode.env.clipboard.writeText(m.text);
          break;
        case "log":
          this.deps.log(`[webview] ${m.message}`);
          break;
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  private async sendPrompt(p: SendPayload) {
    const cfg = vscode.workspace.getConfiguration("museCode");
    if (cfg.get<boolean>("autosave", true)) await vscode.workspace.saveAll(false);
    const display = p.text.trim();
    let text = display;
    const ctx = p.includeEditorContext ? this.deps.editor.current() : null;
    if (ctx) text += "\n\n" + formatEditorContext(ctx);
    const input = turnInputFromPayload(text, p.images);
    if (input.length === 0) return;
    this.remember(display);
    await this.conversation.sendTurn(input, display, p.ifBusy ?? "queue");
  }

  private remember(prompt: string) {
    if (!prompt) return;
    const hist = this.deps.ctx.workspaceState.get<string[]>(HISTORY_KEY, []).filter((h) => h !== prompt);
    hist.push(prompt);
    void this.deps.ctx.workspaceState.update(HISTORY_KEY, hist.slice(-100));
  }

  dispose() {
    this.conversation.dispose();
    for (const d of this.disposables) d.dispose();
    this.webview = null;
  }
}

/** The editor context block appended to the prompt (never shown in the transcript). */
export function formatEditorContext(ctx: EditorContext): string {
  const lines = [`<ide_context>`, `Active file: ${ctx.path}`];
  if (ctx.selection) {
    const { startLine, endLine, text } = ctx.selection;
    lines.push(`Selected lines ${startLine}-${endLine}:`, "```" + ctx.languageId, text, "```");
  }
  lines.push(`</ide_context>`);
  return lines.join("\n");
}
