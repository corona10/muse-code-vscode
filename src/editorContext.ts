import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { EditorContext } from "./protocol";

const VIEWING_DIFF_KEY = "muse-vscode.viewingProposedDiff";

/** Tracks the active editor + selection and offers @-mention and proposed-diff helpers. */
export class EditorContextService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<EditorContext | null>();
  readonly onDidChange = this.emitter.event;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastEditor: vscode.TextEditor | undefined;
  /** Diff editors we opened (modified-side uri strings). */
  private ourDiffs = new Set<string>();

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) this.lastEditor = e;
        this.schedule();
        this.updateDiffContext();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateDiffContext()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.updateDiffContext()),
    );
    this.lastEditor = vscode.window.activeTextEditor;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(this.current()), 120);
  }

  /** The most recent real text editor, even if focus moved to a webview. */
  private editor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    const e = active && active.document.uri.scheme !== "output" ? active : this.lastEditor;
    if (!e || e.document.uri.scheme === "webview-panel" || e.document.uri.scheme === "vscode") return undefined;
    return e;
  }

  current(): EditorContext | null {
    const e = this.editor();
    if (!e || e.document.uri.scheme !== "file") return null;
    const rel = vscode.workspace.asRelativePath(e.document.uri, false);
    const sel = e.selection;
    const selection = sel.isEmpty
      ? null
      : { startLine: sel.start.line + 1, endLine: sel.end.line + 1 - (sel.end.character === 0 && sel.end.line > sel.start.line ? 1 : 0), text: e.document.getText(sel) };
    return { path: rel, absolutePath: e.document.uri.fsPath, languageId: e.document.languageId, selection };
  }

  /** `@path#L3-9` for the active selection, or `@path`. */
  mentionForActiveEditor(): string | null {
    const c = this.current();
    if (!c) return null;
    if (c.selection) {
      const { startLine, endLine } = c.selection;
      return startLine === endLine ? `@${c.path}#L${startLine}` : `@${c.path}#L${startLine}-${endLine}`;
    }
    return `@${c.path}`;
  }

  async listWorkspaceFiles(root: string, respectGitIgnore: boolean): Promise<string[]> {
    if (respectGitIgnore) {
      const viaGit = await new Promise<string[] | null>((resolve) => {
        execFile("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve(null);
          resolve(stdout.split("\0").filter(Boolean));
        });
      });
      if (viaGit) return viaGit;
    }
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, "**/*"), "**/{node_modules,.git,dist,out,build,target}/**", 8000);
    return uris.map((u) => path.relative(root, u.fsPath));
  }

  async pickFileForMention(root: string, respectGitIgnore: boolean): Promise<string | undefined> {
    const files = await this.listWorkspaceFiles(root, respectGitIgnore);
    const items: vscode.QuickPickItem[] = files.sort().map((f) => ({ label: path.basename(f), description: path.dirname(f) === "." ? "" : path.dirname(f), detail: f }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Mention a file", matchOnDescription: true, matchOnDetail: true });
    return picked?.detail;
  }

  async openFile(root: string, rel: string, line?: number) {
    const uri = vscode.Uri.file(path.isAbsolute(rel) ? rel : path.join(root, rel));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  }

  private gitApi(): any | undefined {
    const ext = vscode.extensions.getExtension<any>("vscode.git");
    if (!ext) return undefined;
    const exports = ext.isActive ? ext.exports : undefined;
    return exports?.getAPI?.(1);
  }

  /** Show HEAD vs working tree for a file Muse changed, in the same style as a proposed-change review. */
  async openDiff(root: string, rel: string) {
    const uri = vscode.Uri.file(path.isAbsolute(rel) ? rel : path.join(root, rel));
    const git = this.gitApi();
    const repo = git?.getRepository?.(uri);
    if (!git || !repo) {
      await this.openFile(root, rel);
      return;
    }
    const left = git.toGitUri(uri, "HEAD");
    this.ourDiffs.add(uri.toString());
    await vscode.commands.executeCommand("vscode.diff", left, uri, `${path.basename(uri.fsPath)} (HEAD ↔ Muse changes)`);
    this.updateDiffContext();
  }

  private activeDiffUri(): vscode.Uri | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab?.input;
    if (input instanceof vscode.TabInputTextDiff && this.ourDiffs.has(input.modified.toString())) return input.modified;
    return undefined;
  }

  private updateDiffContext() {
    void vscode.commands.executeCommand("setContext", VIEWING_DIFF_KEY, !!this.activeDiffUri());
  }

  /** Accept keeps the working-tree change (Muse already wrote it) and closes the review. */
  async acceptProposedDiff() {
    const uri = this.activeDiffUri();
    if (!uri) return;
    this.ourDiffs.delete(uri.toString());
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    this.updateDiffContext();
  }

  /** Reject restores the file from HEAD via the git extension. */
  async rejectProposedDiff() {
    const uri = this.activeDiffUri();
    if (!uri) return;
    const git = this.gitApi();
    const repo = git?.getRepository?.(uri);
    if (!repo) {
      void vscode.window.showWarningMessage("Cannot revert: file is not in a git repository.");
      return;
    }
    const answer = await vscode.window.showWarningMessage(`Discard Muse's changes to ${path.basename(uri.fsPath)} and restore it from HEAD?`, { modal: true }, "Discard changes");
    if (answer !== "Discard changes") return;
    await repo.clean([uri.fsPath]);
    this.ourDiffs.delete(uri.toString());
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    this.updateDiffContext();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
