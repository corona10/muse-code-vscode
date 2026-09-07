import * as vscode from "vscode";
import { MuseHost, hostOptionsFor } from "./msp/host";

/** One MuseHost per workspace root, created lazily. */
export class HostManager implements vscode.Disposable {
  private hosts = new Map<string, MuseHost>();
  constructor(private readonly ctx: vscode.ExtensionContext, private readonly log: (l: string) => void) {}

  get(workspaceRoot: string): MuseHost {
    let h = this.hosts.get(workspaceRoot);
    if (!h) {
      h = new MuseHost(hostOptionsFor(workspaceRoot, this.ctx, this.log));
      this.hosts.set(workspaceRoot, h);
    }
    return h;
  }

  /** Drop every host so the next request re-spawns with fresh configuration. */
  reset() {
    for (const h of this.hosts.values()) h.dispose();
    this.hosts.clear();
  }

  dispose() {
    this.reset();
  }
}
