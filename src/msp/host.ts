import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { NdjsonRpcClient, JsonRpcError } from "./jsonrpc";
import type { InitializeResult } from "./msp";
import type { HostStatus } from "../protocol";
import { resolveExecutable, resetExecutableCache } from "../resolveExecutable";

const CLIENT_NAME = "muse_code_vscode"; // must match ^[a-z0-9_]+$ (MSP SS1.4.1)

export interface HostOptions {
  workspaceRoot: string;
  executable: string;
  env: Record<string, string>;
  trustWorkspace: boolean;
  version: string;
  log: (line: string) => void;
}

/**
 * One `muse serve` process per workspace folder. Owns the JSON-RPC connection,
 * performs the initialize/initialized handshake, and fans notifications out by session id.
 */
export class MuseHost extends EventEmitter {
  private proc: ChildProcess | null = null;
  private client: NdjsonRpcClient | null = null;
  private stderrTail = "";
  status: HostStatus = "stopped";
  statusMessage: string | null = null;
  initResult: InitializeResult | null = null;
  private starting: Promise<void> | null = null;

  constructor(readonly opts: HostOptions) {
    super();
  }

  get workspaceRoot() {
    return this.opts.workspaceRoot;
  }

  get userShellGranted(): boolean {
    return this.initResult?.grantedCapabilities.includes("userShell") ?? false;
  }

  /** Idempotent: concurrent callers share one start attempt. */
  ensureStarted(): Promise<void> {
    if (this.status === "ready") return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private setStatus(status: HostStatus, message: string | null = null) {
    this.status = status;
    this.statusMessage = message;
    this.emit("status", status, message);
  }

  private async start(): Promise<void> {
    this.setStatus("starting");
    const args = ["serve"];
    if (this.opts.trustWorkspace) args.push("--trust-workspace");
    const executable = await resolveExecutable(this.opts.executable, this.opts.log);
    this.opts.log(`spawning: ${executable} ${args.join(" ")} (cwd ${this.opts.workspaceRoot})`);
    let proc: ChildProcess;
    try {
      proc = spawn(executable, args, {
        cwd: this.opts.workspaceRoot,
        env: { ...process.env, ...this.opts.env, MUSE_CLIENT: "vscode" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e: any) {
      this.setStatus("failed", `Could not launch ${executable}: ${e?.message ?? e}`);
      throw new Error(this.statusMessage!);
    }
    this.proc = proc;
    this.stderrTail = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
      for (const line of d.split("\n")) if (line.trim()) this.opts.log(`[muse stderr] ${line}`);
    });

    const spawned = new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") resetExecutableCache();
        reject(
          err.code === "ENOENT"
            ? new Error(`'${executable}' was not found. Install Muse Code and make sure it is on your PATH, or set museCode.executablePath.`)
            : err,
        );
      });
    });
    try {
      await spawned;
    } catch (e: any) {
      this.proc = null;
      this.setStatus("failed", e.message);
      throw e;
    }

    const client = new NdjsonRpcClient(proc);
    this.client = client;
    client.on("log", (l: string) => this.opts.log(l));
    client.on("notification", (method: string, params: any) => {
      this.emit("notification", method, params);
      const sid = params?.sessionId ?? params?.session?.sessionId;
      if (sid) this.emit(`session:${sid}`, method, params);
    });
    client.on("exit", (code: number | null) => {
      const wasReady = this.status === "ready";
      this.client = null;
      this.proc = null;
      const tail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
      const msg = `Muse host exited${code !== null ? ` with code ${code}` : ""}${tail ? `: ${tail}` : ""}`;
      this.opts.log(msg);
      this.setStatus(wasReady ? "stopped" : "failed", msg);
    });

    try {
      const init = await client.request<InitializeResult>("initialize", {
        clientInfo: { name: CLIENT_NAME, title: "Muse Code for VS Code", version: this.opts.version },
        capabilities: { requestedCapabilities: ["userShell"] },
      });
      client.notify("initialized", {});
      this.initResult = init;
      this.opts.log(`initialized: ${init.serverInfo.name} ${init.serverInfo.version}, schema v${init.schema.version}, capabilities=${init.grantedCapabilities.join(",") || "none"}`);
      this.setStatus("ready");
    } catch (e: any) {
      const msg = e instanceof JsonRpcError ? e.message : `${e?.message ?? e}`;
      this.setStatus("failed", `Muse host handshake failed: ${msg}`);
      client.dispose();
      throw new Error(this.statusMessage!);
    }
  }

  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    if (!this.client) throw new Error("Muse host is not running");
    return this.client.request<T>(method, params);
  }

  /** Whether the last failure looks like an authentication problem worth a login prompt. */
  looksLikeAuthFailure(text: string | null | undefined): boolean {
    return !!text && /\b(login|log in|unauthori[sz]ed|authenticat|credential|401|403|token expired|not logged in)\b/i.test(text);
  }

  restart(): Promise<void> {
    this.dispose();
    return this.ensureStarted();
  }

  dispose() {
    this.client?.dispose();
    this.client = null;
    this.proc = null;
    if (this.status !== "stopped") this.setStatus("stopped");
  }
}

/** Resolves configuration into host options for a workspace folder. */
export function hostOptionsFor(workspaceRoot: string, ctx: vscode.ExtensionContext, log: (l: string) => void): HostOptions {
  const cfg = vscode.workspace.getConfiguration("museCode");
  const env: Record<string, string> = {};
  for (const e of cfg.get<{ name: string; value: string }[]>("environmentVariables", [])) {
    if (e?.name) env[e.name] = String(e.value ?? "");
  }
  return {
    workspaceRoot,
    executable: cfg.get<string>("executablePath", "muse") || "muse",
    env,
    trustWorkspace: vscode.workspace.isTrusted,
    version: (ctx.extension.packageJSON.version as string) ?? "0.0.0",
    log,
  };
}
