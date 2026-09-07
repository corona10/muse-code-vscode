import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 * `muse serve` speaks exactly this: one JSON object per line, no Content-Length framing.
 */
export interface RpcError {
  code: number;
  message: string;
  data?: { kind?: string; [k: string]: unknown };
}

export class JsonRpcError extends Error {
  constructor(public readonly rpc: RpcError, public readonly method: string) {
    super(`${method}: ${rpc.message} (${rpc.data?.kind ?? rpc.code})`);
  }
  get kind(): string | undefined {
    return this.rpc.data?.kind;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };

export class NdjsonRpcClient extends EventEmitter {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  constructor(private readonly proc: ChildProcess) {
    super();
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onData(chunk));
    proc.on("exit", (code, signal) => this.onExit(code, signal));
    proc.on("error", (err) => this.emit("error", err));
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`${method}: host is not running`));
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.proc.stdin!.write(line + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit("log", `unparseable line from host: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: any) {
    if (msg.id !== undefined && msg.id !== null && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ("error" in msg) p.reject(new JsonRpcError(msg.error, p.method));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      // Server-initiated notification (or request; MSP v1 only pushes notifications).
      this.emit("notification", msg.method, msg.params ?? {}, msg.id);
      return;
    }
    if (msg.id === null && msg.error) {
      this.emit("log", `host error without id: ${JSON.stringify(msg.error)}`);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null) {
    this.closed = true;
    const err = new Error(`muse host exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.emit("exit", code, signal);
  }

  dispose() {
    this.closed = true;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    if (this.proc.exitCode === null) this.proc.kill();
  }
}
