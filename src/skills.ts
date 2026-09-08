import { execFile } from "node:child_process";
import * as vscode from "vscode";
import type { SkillEntry } from "./protocol";
import { resolveExecutable } from "./resolveExecutable";

const SCOPE_ORDER: Record<string, number> = { project: 0, user: 1, plugin: 2, bundled: 3 };

/**
 * Skills the `muse` CLI knows about for a workspace (`.agents/skills/<name>/SKILL.md` in the project,
 * plus user, plugin and bundled ones). MSP has no skill listing method, so this shells out to
 * `muse skills list --json` and caches per workspace; edits under `.agents/skills` invalidate the cache.
 */
export class SkillCatalog implements vscode.Disposable {
  private cache = new Map<string, SkillEntry[]>();
  private inflight = new Map<string, Promise<SkillEntry[]>>();
  private emitter = new vscode.EventEmitter<string | null>();
  /** Fires with the workspace root whose list changed, or null when every cache was dropped. */
  readonly onDidChange = this.emitter.event;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (l: string) => void) {
    const watcher = vscode.workspace.createFileSystemWatcher("**/.agents/skills/**/SKILL.md");
    const bump = (uri: vscode.Uri) => this.invalidate(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? null);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(bump),
      watcher.onDidChange(bump),
      watcher.onDidDelete(bump),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (["museCode.slashSkillScopes", "museCode.executablePath", "museCode.environmentVariables"].some((k) => e.affectsConfiguration(k))) this.invalidate(null);
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.invalidate(null)),
    );
  }

  invalidate(workspaceRoot: string | null) {
    if (workspaceRoot) this.cache.delete(workspaceRoot);
    else this.cache.clear();
    this.emitter.fire(workspaceRoot);
  }

  list(workspaceRoot: string): Promise<SkillEntry[]> {
    const cached = this.cache.get(workspaceRoot);
    if (cached) return Promise.resolve(cached);
    let p = this.inflight.get(workspaceRoot);
    if (!p) {
      p = this.load(workspaceRoot)
        .then((list) => {
          this.cache.set(workspaceRoot, list);
          return list;
        })
        .finally(() => this.inflight.delete(workspaceRoot));
      this.inflight.set(workspaceRoot, p);
    }
    return p;
  }

  private async load(workspaceRoot: string): Promise<SkillEntry[]> {
    const cfg = vscode.workspace.getConfiguration("museCode");
    const scopes = new Set(cfg.get<string[]>("slashSkillScopes", ["project", "user", "plugin"]));
    if (!scopes.size) return [];
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const e of cfg.get<{ name: string; value: string }[]>("environmentVariables", [])) if (e?.name) env[e.name] = String(e.value ?? "");
    const exe = await resolveExecutable(cfg.get<string>("executablePath", "muse") || "muse", this.log);
    const args = ["skills", "list", "--json", "--workspace", workspaceRoot];
    if (vscode.workspace.isTrusted) args.push("--trust-workspace");
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) =>
        execFile(exe, args, { cwd: workspaceRoot, env, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(new Error(stderr?.trim() || err.message)) : resolve(out))),
      );
    } catch (e: any) {
      this.log(`skills list failed: ${e?.message ?? e}`);
      return [];
    }
    let raw: any;
    try {
      raw = JSON.parse(stdout);
    } catch {
      this.log("skills list returned invalid JSON");
      return [];
    }
    const seen = new Set<string>();
    const out: SkillEntry[] = [];
    const rows: any[] = Array.isArray(raw?.skills) ? raw.skills : [];
    rows.sort((a, b) => (SCOPE_ORDER[a?.scope] ?? 9) - (SCOPE_ORDER[b?.scope] ?? 9) || String(a?.name).localeCompare(String(b?.name)));
    for (const s of rows) {
      if (!s?.name || s.activation !== "on" || !scopes.has(s.scope)) continue;
      const name = String(s.name);
      if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || seen.has(name)) continue; // one command per name; higher-priority scope wins
      seen.add(name);
      out.push({ id: String(s.id ?? name), name, description: String(s.short_description || s.description || ""), scope: String(s.scope ?? ""), path: String(s.path ?? "") });
    }
    this.log(`skills: ${out.length} listed for ${workspaceRoot}`);
    return out;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
