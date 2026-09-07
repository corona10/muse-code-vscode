import * as vscode from "vscode";

/** The terminal-style experience: run the muse TUI in an integrated terminal. */
export class TerminalMode implements vscode.Disposable {
  private terminals = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [k, v] of this.terminals) if (v === t) this.terminals.delete(k);
      }),
    );
  }

  open(workspaceRoot: string, extraArgs: string[] = []): vscode.Terminal {
    let t = this.terminals.get(workspaceRoot);
    if (!t) {
      const cfg = vscode.workspace.getConfiguration("museCode");
      const env: Record<string, string> = {};
      for (const e of cfg.get<{ name: string; value: string }[]>("environmentVariables", [])) if (e?.name) env[e.name] = String(e.value ?? "");
      t = vscode.window.createTerminal({ name: "Muse Code", cwd: workspaceRoot, env, iconPath: new vscode.ThemeIcon("sparkle") });
      this.terminals.set(workspaceRoot, t);
      const exe = cfg.get<string>("executablePath", "muse") || "muse";
      t.sendText(`${quote(exe)} ${extraArgs.map(quote).join(" ")}`.trim(), true);
    }
    t.show(false);
    return t;
  }

  /** Runs a one-off muse subcommand (login/logout) in a fresh terminal. */
  run(workspaceRoot: string | undefined, args: string[]) {
    const cfg = vscode.workspace.getConfiguration("museCode");
    const exe = cfg.get<string>("executablePath", "muse") || "muse";
    const t = vscode.window.createTerminal({ name: `muse ${args[0] ?? ""}`.trim(), cwd: workspaceRoot });
    t.show(true);
    t.sendText(`${quote(exe)} ${args.map(quote).join(" ")}`, true);
  }

  /** Types an @-mention into the running TUI without submitting it. */
  insertText(workspaceRoot: string, text: string) {
    const t = this.open(workspaceRoot);
    t.sendText(text + " ", false);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function quote(s: string): string {
  return /^[\w./@:=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
