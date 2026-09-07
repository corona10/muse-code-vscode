import * as vscode from "vscode";
import { resetExecutableCache } from "./resolveExecutable";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { ChatController, ControllerDeps } from "./chatController";
import { EditorContextService } from "./editorContext";
import { HostManager } from "./hosts";
import { PANEL_VIEW_TYPE, PanelManager, SIDEBAR_VIEW_IDS, SidebarProvider } from "./panels";
import { TerminalMode } from "./terminalMode";

const OPEN_ON_ACTIVATE_KEY = "muse-vscode.openOnActivate";

export async function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("Muse Code");
  const log = (l: string) => output.appendLine(`[${new Date().toISOString()}] ${l}`);
  const hosts = new HostManager(ctx, log);
  const editor = new EditorContextService();
  const terminal = new TerminalMode();
  const deps: Omit<ControllerDeps, "location"> = { ctx, hosts, editor, log };
  const panels = new PanelManager({ ...deps, location: "panel" });
  const sidebar = new SidebarProvider({ ...deps, location: "sidebar" }, () => resolveWorkspaceRoot());
  ctx.subscriptions.push(output, hosts, editor, terminal, panels, sidebar);

  // Secondary side bar containers exist from VS Code 1.97; older builds fall back to the activity bar.
  const [maj, min] = vscode.version.split(".").map((n) => parseInt(n, 10));
  const supportsSecondary = maj > 1 || (maj === 1 && min >= 97);
  await vscode.commands.executeCommand("setContext", "muse-code:doesNotSupportSecondarySidebar", !supportsSecondary);
  await vscode.commands.executeCommand("setContext", "muse-vscode.createWorktreeEnabled", !!vscode.workspace.workspaceFolders?.length);

  for (const id of SIDEBAR_VIEW_IDS) ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(id, sidebar, { webviewOptions: { retainContextWhenHidden: true } }));
  ctx.subscriptions.push(vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, panels));

  const useTerminal = () => vscode.workspace.getConfiguration("museCode").get<boolean>("useTerminal", false);
  const preferred = () => vscode.workspace.getConfiguration("museCode").get<"sidebar" | "panel">("preferredLocation", "panel");
  const setPreferred = (loc: "sidebar" | "panel") => vscode.workspace.getConfiguration("museCode").update("preferredLocation", loc, vscode.ConfigurationTarget.Global);

  /** The controller the user is most plausibly looking at. */
  const activeController = (): ChatController | undefined => {
    const p = panels.active;
    if (p?.panel.active) return p.controller;
    if (sidebar.visible && sidebar.controller) return sidebar.controller;
    return p?.controller ?? sidebar.controller ?? undefined;
  };

  const openPreferred = async (resumeSessionId?: string) => {
    const root = await resolveWorkspaceRoot();
    if (!root) return;
    if (useTerminal()) {
      terminal.open(root, resumeSessionId ? ["resume", resumeSessionId] : []);
      return;
    }
    if (preferred() === "sidebar") await sidebar.reveal(resumeSessionId);
    else if (resumeSessionId) await panels.open(root, { resumeSessionId });
    else await panels.openLast(root);
  };

  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd("muse-vscode.editor.open", async () => {
    const root = await resolveWorkspaceRoot();
    if (!root) return;
    await setPreferred("panel");
    await panels.open(root);
  });
  cmd("muse-vscode.editor.openLast", () => openPreferred());
  cmd("muse-vscode.sidebar.open", async () => {
    await setPreferred("sidebar");
    await sidebar.reveal();
  });
  cmd("muse-vscode.newConversation", async () => {
    const c = activeController();
    if (c) await c.newConversation();
    else await openPreferred();
  });
  cmd("muse-vscode.resumeConversation", async () => {
    const c = activeController();
    if (!c) return openPreferred();
    const sessions = await c.conversation.listSessions();
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.title || "(untitled)", description: `${s.turnCount} turns · ${new Date(s.updatedAt).toLocaleString()}`, detail: s.sessionId, sessionId: s.sessionId })),
      { placeHolder: "Resume a past conversation" },
    );
    if (pick) await c.resume(pick.sessionId);
  });
  cmd("muse-vscode.reopenClosedSession", async () => {
    if (!(await panels.reopenClosed())) await vscode.commands.executeCommand("workbench.action.reopenClosedEditor");
  });
  cmd("muse-vscode.focus", async () => {
    const c = activeController();
    if (!c) return openPreferred();
    const p = panels.active;
    if (p && c === p.controller) p.reveal();
    else await sidebar.reveal();
    c.focusInput();
  });
  cmd("muse-vscode.blur", async () => {
    activeController()?.blurInput();
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  });
  cmd("muse-vscode.terminal.open", async () => {
    const root = await resolveWorkspaceRoot();
    if (root) terminal.open(root);
  });
  cmd("muse-vscode.terminal.open.keyboard", () => vscode.commands.executeCommand("muse-vscode.terminal.open"));
  cmd("muse-vscode.insertAtMention", async () => {
    const m = editor.mentionForActiveEditor();
    if (!m) return;
    let c = activeController();
    if (!c) {
      await openPreferred();
      c = activeController();
    }
    c?.insertText(m + " ");
    c?.focusInput();
  });
  cmd("muse-vscode.insertAtMentioned", async () => {
    const m = editor.mentionForActiveEditor();
    const root = await resolveWorkspaceRoot();
    if (m && root) terminal.insertText(root, m);
  });
  cmd("muse-vscode.acceptProposedDiff", () => editor.acceptProposedDiff());
  cmd("muse-vscode.rejectProposedDiff", () => editor.rejectProposedDiff());
  cmd("muse-vscode.showLogs", () => output.show(true));
  cmd("muse-vscode.toggleFocusView", async () => {
    const cfg = vscode.workspace.getConfiguration("museCode");
    await cfg.update("focusView", !cfg.get<boolean>("focusView", false), vscode.ConfigurationTarget.Global);
  });
  cmd("muse-vscode.openWalkthrough", () => vscode.commands.executeCommand("workbench.action.openWalkthrough", `${ctx.extension.id}#muse-code-walkthrough`, false));
  cmd("muse-vscode.markSessionUnread", () => panels.active?.markUnread());
  cmd("muse-vscode.renameSessionTab", async () => {
    const p = panels.active;
    if (!p) return;
    const title = await vscode.window.showInputBox({ prompt: "Session tab title", value: p.panel.title });
    if (title) p.rename(title);
  });
  cmd("muse-vscode.login", async () => terminal.run(await resolveWorkspaceRoot(), ["login"]));
  cmd("muse-vscode.logout", async () => terminal.run(await resolveWorkspaceRoot(), ["logout"]));
  cmd("muse-vscode.restartHost", async () => {
    hosts.reset();
    void vscode.window.showInformationMessage("Muse session host stopped. It restarts with your next message; open a new conversation to continue.");
  });
  cmd("muse-vscode.window.open", async () => {
    const root = await resolveWorkspaceRoot();
    if (!root) return;
    await ctx.globalState.update(OPEN_ON_ACTIVATE_KEY, root);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(root), { forceNewWindow: true });
  });
  cmd("muse-vscode.createWorktree", async () => {
    const root = await resolveWorkspaceRoot();
    if (!root) return;
    const name = await vscode.window.showInputBox({ prompt: "Branch name for the new worktree", placeHolder: "feature/my-change", validateInput: (v) => (/^[\w./-]+$/.test(v) ? undefined : "Use letters, digits, / . _ -") });
    if (!name) return;
    const dir = path.join(path.dirname(root), `${path.basename(root)}-${name.replace(/[\/]/g, "-")}`);
    try {
      await new Promise<void>((resolve, reject) => execFile("git", ["worktree", "add", "-b", name, dir], { cwd: root }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
    } catch (e: any) {
      void vscode.window.showErrorMessage(`git worktree add failed: ${e.message}`);
      return;
    }
    await ctx.globalState.update(OPEN_ON_ACTIVATE_KEY, dir);
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: true });
  });

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("museCode.executablePath") || e.affectsConfiguration("museCode.environmentVariables")) {
        resetExecutableCache();
        hosts.reset();
        log("configuration changed: session hosts will respawn on next use");
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => hosts.reset()),
  );

  // A window opened by "Open in New Window" / "Create Worktree" opens Muse right away.
  const pending = ctx.globalState.get<string>(OPEN_ON_ACTIVATE_KEY);
  if (pending && vscode.workspace.workspaceFolders?.some((f) => f.uri.fsPath === pending)) {
    await ctx.globalState.update(OPEN_ON_ACTIVATE_KEY, undefined);
    void openPreferred();
  }
  log(`Muse Code for VS Code ${ctx.extension.packageJSON.version} activated`);
}

export function deactivate() {}

/** The folder Muse should treat as its workspace: the active editor's folder, the only folder, or a pick. */
async function resolveWorkspaceRoot(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    const choice = await vscode.window.showWarningMessage("Muse Code needs an open folder. Use your home directory as the workspace?", "Use home directory", "Open Folder…");
    if (choice === "Open Folder…") {
      await vscode.commands.executeCommand("workbench.action.files.openFolder");
      return undefined;
    }
    return choice ? os.homedir() : undefined;
  }
  if (folders.length === 1) return folders[0].uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  const owning = active ? vscode.workspace.getWorkspaceFolder(active) : undefined;
  if (owning) return owning.uri.fsPath;
  const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Workspace folder for Muse" });
  return pick?.uri.fsPath;
}
