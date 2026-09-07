import { EventEmitter } from "node:events";
import * as path from "node:path";
import { MuseHost } from "./msp/host";
import { JsonRpcError } from "./msp/jsonrpc";
import { uuid7 } from "./msp/uuid7";
import type {
  ApprovalDecideResult,
  ApprovalListPendingResult,
  ApprovalMode,
  ApprovalRequestParams,
  Item,
  ModelCatalogEntry,
  ModelListResult,
  ReasoningEffort,
  Session,
  SessionListResult,
  SessionReadResult,
  SessionResumeResult,
  SessionStartResult,
  SessionUserShellResult,
  SnapshotState,
  TurnInputPart,
  TurnStartResult,
  UnframedViewNotification,
  UserInputAnswer,
  UserInputRequestParams,
  ViewPageResult,
} from "./msp/msp";
import type { SessionSummary, ToWebview, UiMeta, UiState } from "./protocol";

export interface ConversationOptions {
  approvalMode?: ApprovalMode | null;
  modelId?: string;
  reasoningEffort?: ReasoningEffort | null;
}

const FILE_TOOL = /write|edit|patch|create|replace|apply|delete|remove|rename|move|insert/i;
const PATH_KEYS = ["path", "file_path", "filePath", "target_file", "file", "filename", "target", "destination", "new_path"];

/**
 * The per-session model on the extension side: folds MSP view events into a UI state
 * and exposes the commands the chat needs. Emits `message` with ToWebview payloads.
 */
export class Conversation extends EventEmitter {
  state: UiState;
  private listener: ((method: string, params: any) => void) | null = null;
  private disposed = false;

  constructor(readonly host: MuseHost, readonly workspaceRoot: string, private opts: ConversationOptions = {}) {
    super();
    this.state = {
      sessionId: null,
      workspaceRoot,
      items: [],
      approvals: [],
      userInputs: [],
      changedFiles: [],
      meta: {
        running: false,
        activeTurnId: null,
        queuedTurns: [],
        approvalMode: null,
        modelId: opts.modelId ?? null,
        reasoningEffort: opts.reasoningEffort ?? null,
        contextUsage: null,
        tokenUsage: null,
        todo: [],
        branch: null,
        title: null,
        hostStatus: host.status,
        hostMessage: host.statusMessage,
        lastError: null,
      },
    };
    host.on("status", this.onHostStatus);
  }

  private onHostStatus = (status: UiMeta["hostStatus"], message: string | null) => {
    if (status !== "ready" && this.state.sessionId) {
      // The host is gone: the session is no longer loaded anywhere we can talk to.
      this.detach();
      this.state.meta.running = false;
      this.state.meta.activeTurnId = null;
    }
    this.patchMeta({ hostStatus: status, hostMessage: message });
  };

  get sessionId() {
    return this.state.sessionId;
  }

  private send(msg: ToWebview) {
    if (!this.disposed) this.emit("message", msg);
  }

  private patchMeta(patch: Partial<UiMeta>) {
    Object.assign(this.state.meta, patch);
    this.send({ type: "meta", meta: patch });
  }

  toast(level: "info" | "warning" | "error", message: string, action?: { label: string; command: string }) {
    this.send({ type: "toast", level, message, action });
  }

  // ---------- lifecycle ----------

  private attach(sessionId: string) {
    this.detach();
    this.state.sessionId = sessionId;
    this.listener = (method, params) => this.applyEvent(method, params, true);
    this.host.on(`session:${sessionId}`, this.listener);
  }

  private detach() {
    if (this.listener && this.state.sessionId) this.host.off(`session:${this.state.sessionId}`, this.listener);
    this.listener = null;
  }

  private resetState(session: Session | null) {
    this.state.items = [];
    this.state.approvals = [];
    this.state.userInputs = [];
    this.state.changedFiles = [];
    Object.assign(this.state.meta, {
      running: session?.status === "running",
      activeTurnId: session?.activeTurnId ?? null,
      queuedTurns: [],
      approvalMode: session?.approvalMode?.mode ?? null,
      modelId: session?.modelId ?? this.opts.modelId ?? null,
      contextUsage: null,
      tokenUsage: null,
      todo: [],
      branch: null,
      title: null,
      lastError: null,
    } satisfies Partial<UiMeta>);
  }

  async startNew(): Promise<void> {
    await this.host.ensureStarted();
    const params: Record<string, unknown> = { commandId: uuid7(), workspaceRoot: this.workspaceRoot };
    if (this.opts.approvalMode) params.approvalMode = this.opts.approvalMode;
    if (this.opts.modelId) params.modelId = this.opts.modelId;
    const r = await this.host.request<SessionStartResult>("session/start", params);
    this.resetState(r.session);
    this.attach(r.session.sessionId);
    this.send({ type: "state", state: this.state });
  }

  async resume(sessionId: string): Promise<void> {
    await this.host.ensureStarted();
    const r = await this.host.request<SessionResumeResult>("session/resume", { commandId: uuid7(), sessionId, history: "auto" });
    this.resetState(r.session);
    this.attach(r.session.sessionId);
    const h = r.history;
    if (h.mode === "inline" && h.items) {
      for (const it of h.items) this.upsertItem(it, false);
    } else if ((h.mode === "snapshot" || h.mode === "anchoredSnapshot") && h.snapshot) {
      this.applySnapshot(h.snapshot.state);
    } else {
      await this.pageAll(sessionId);
    }
    if (r.pendingRequests.length > 0) await this.refreshPending();
    this.state.meta.title = this.deriveTitle();
    this.send({ type: "state", state: this.state });
  }

  private applySnapshot(s: SnapshotState) {
    for (const it of s.items) this.upsertItem(it, false);
    const m = this.state.meta;
    m.approvalMode = s.approvalMode?.mode ?? m.approvalMode;
    m.modelId = s.effectiveModel?.modelId ?? m.modelId;
    m.contextUsage = s.contextUsage ?? null;
    m.tokenUsage = s.tokenUsage ?? null;
    m.todo = s.todoList?.items ?? [];
    m.branch = s.branch?.branch ?? null;
    m.running = !!s.activeTurn;
    m.activeTurnId = s.activeTurn?.turnId ?? null;
    m.queuedTurns = s.queuedTurns.map((t) => ({ turnId: t.turnId, text: "" }));
  }

  private async pageAll(sessionId: string) {
    let cursor: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = await this.host.request<ViewPageResult>("view/page", { sessionId, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const ev of page.events) this.applyEvent(ev.method, ev.params, false);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  private async refreshPending() {
    if (!this.state.sessionId) return;
    const p = await this.host.request<ApprovalListPendingResult>("approval/listPending", { sessionId: this.state.sessionId });
    this.state.approvals = p.approvals;
    this.state.userInputs = p.userInputs;
  }

  /** Fill a hole reported by view/gap by paging the missing range. */
  private async fillGap(after: string, next: string) {
    if (!this.state.sessionId) return;
    let cursor = after;
    for (let guard = 0; guard < 50; guard++) {
      const page = await this.host.request<ViewPageResult>("view/page", { sessionId: this.state.sessionId, cursor, limit: 1000 });
      for (const ev of page.events) {
        if (ev.params.viewCursor >= next) return;
        this.applyEvent(ev.method, ev.params, true);
      }
      if (!page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  // ---------- event fold ----------

  private upsertItem(item: Item, live: boolean) {
    const idx = this.state.items.findIndex((i) => i.itemId === item.itemId);
    if (idx >= 0) {
      const cur = this.state.items[idx];
      if (item.revision < cur.revision) return;
      // Keep streamed text if the durable re-emission is behind what deltas built (saturation aside).
      if (item.kind === "agentMessage" && cur.text && (!item.text || item.text.length < cur.text.length) && item.status === "inProgress") item.text = cur.text;
      this.state.items[idx] = item;
    } else {
      this.state.items.push(item);
    }
    if (item.kind === "userMessage" && !this.state.meta.title) {
      this.state.meta.title = this.deriveTitle();
      if (live) this.send({ type: "meta", meta: { title: this.state.meta.title } });
    }
    if (item.kind === "toolCall" && item.status !== "inProgress") this.trackChangedFile(item, live);
    if (live) this.send({ type: "item", item });
  }

  private trackChangedFile(item: Item, live: boolean) {
    if (!item.tool || !FILE_TOOL.test(item.tool) || !item.args || item.status !== "completed") return;
    let args: any;
    try {
      args = JSON.parse(item.args);
    } catch {
      return;
    }
    if (!args || typeof args !== "object") return;
    const found: string[] = [];
    for (const k of PATH_KEYS) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) found.push(v);
    }
    if (Array.isArray(args.edits)) for (const e of args.edits) if (e && typeof e.path === "string") found.push(e.path);
    let changed = false;
    for (const f of found) {
      const abs = path.isAbsolute(f) ? f : path.join(this.workspaceRoot, f);
      const rel = path.relative(this.workspaceRoot, abs);
      if (rel.startsWith("..")) continue;
      if (!this.state.changedFiles.includes(rel)) {
        this.state.changedFiles.push(rel);
        changed = true;
      }
    }
    if (changed && live) this.send({ type: "changedFiles", files: this.state.changedFiles });
  }

  private deriveTitle(): string | null {
    const first = this.state.items.find((i) => i.kind === "userMessage");
    const t = (first?.displayText ?? first?.text ?? "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    return t.length > 48 ? t.slice(0, 47) + "…" : t;
  }

  applyEvent(method: string, params: any, live: boolean) {
    const m = this.state.meta;
    switch (method) {
      case "item/started":
      case "item/updated":
      case "item/completed":
        this.upsertItem(params.item as Item, live);
        break;
      case "item/delta": {
        const it = this.state.items.find((i) => i.itemId === params.itemId);
        const field: string = params.field ?? "text";
        if (it) {
          if (field === "text") it.text = (it.text ?? "") + params.delta;
          else if (field === "output") it.visibleOutput = (it.visibleOutput ?? "") + params.delta;
          else if (field.startsWith("summary.")) {
            const n = Number(field.slice(8));
            it.summary = it.summary ?? [];
            it.summary[n] = (it.summary[n] ?? "") + params.delta;
          } else (it as any)[field] = ((it as any)[field] ?? "") + params.delta;
        }
        if (live) this.send({ type: "delta", itemId: params.itemId, field, delta: params.delta });
        break;
      }
      case "turn/started":
        m.queuedTurns = m.queuedTurns.filter((q) => q.turnId !== params.turnId);
        m.lastError = null;
        if (live) this.patchMeta({ running: true, activeTurnId: params.turnId, queuedTurns: m.queuedTurns, lastError: null });
        else Object.assign(m, { running: true, activeTurnId: params.turnId });
        break;
      case "turn/completed": {
        const patch: Partial<UiMeta> = {};
        if (m.activeTurnId === params.turnId || !m.activeTurnId) {
          patch.running = false;
          patch.activeTurnId = null;
        }
        if (params.terminal === "failed" && params.error) patch.lastError = params.error;
        if (live) {
          this.patchMeta(patch);
          if (params.terminal === "failed") {
            const msg = params.error?.message ?? params.reason ?? "Turn failed";
            this.toast("error", msg, this.host.looksLikeAuthFailure(msg) ? { label: "Login", command: "muse-vscode.login" } : undefined);
          }
          this.emit("turnCompleted", params);
        } else Object.assign(m, patch);
        break;
      }
      case "turn/unqueued":
        m.queuedTurns = m.queuedTurns.filter((q) => q.turnId !== params.turnId);
        if (live) this.patchMeta({ queuedTurns: m.queuedTurns });
        break;
      case "turn/retracted": {
        const um = this.state.items.find((i) => i.kind === "userMessage" && i.turnId === params.turnId);
        if (um) {
          um.retracted = true;
          if (live) {
            this.send({ type: "item", item: um });
            this.send({ type: "restorePrompt", text: um.displayText ?? um.text ?? "" });
          }
        }
        break;
      }
      case "turn/retryScheduled":
        if (live) this.toast("warning", `Model attempt ${params.attempt}/${params.maxAttempts} failed (${params.reason}); retrying in ${Math.round(params.retryDelayMs / 1000)}s`);
        break;
      case "approval/requested": {
        const a = params as ApprovalRequestParams;
        this.state.approvals = this.state.approvals.filter((x) => x.approvalId !== a.approvalId).concat(a);
        if (live) this.send({ type: "approval", approval: a });
        break;
      }
      case "approval/updated": {
        const cur = this.state.approvals.find((x) => x.approvalId === params.approvalId);
        if (cur) {
          cur.availableChoices = params.availableChoices;
          cur.currentRequirementId = params.currentRequirementId;
          cur.subject = params.subject;
          if (live) this.send({ type: "approval", approval: cur });
        }
        break;
      }
      case "approval/resolved":
        this.state.approvals = this.state.approvals.filter((x) => x.approvalId !== params.approvalId);
        if (live) this.send({ type: "approvalResolved", approvalId: params.approvalId });
        break;
      case "userInput/requested": {
        const u = params as UserInputRequestParams;
        this.state.userInputs = this.state.userInputs.filter((x) => x.userInputId !== u.userInputId).concat(u);
        if (live) this.send({ type: "userInput", request: u });
        break;
      }
      case "userInput/settled":
        this.state.userInputs = this.state.userInputs.filter((x) => x.userInputId !== params.userInputId);
        if (live) this.send({ type: "userInputSettled", userInputId: params.userInputId });
        break;
      case "session/tokenUsage":
        m.tokenUsage = params.cumulative;
        if (live) this.patchMeta({ tokenUsage: m.tokenUsage });
        break;
      case "session/contextUsage":
        m.contextUsage = { pressure: params.pressure, usedTokens: params.usedTokens, windowTokens: params.windowTokens };
        if (live) this.patchMeta({ contextUsage: m.contextUsage });
        break;
      case "session/todoListChanged":
        m.todo = params.items ?? [];
        if (live) this.patchMeta({ todo: m.todo });
        break;
      case "session/modelChanged":
        m.modelId = params.modelId;
        if (live) this.patchMeta({ modelId: m.modelId });
        break;
      case "session/approvalModeChanged":
        m.approvalMode = params.mode;
        if (live) this.patchMeta({ approvalMode: m.approvalMode });
        break;
      case "session/branchChanged":
        m.branch = params.branch ?? null;
        if (live) this.patchMeta({ branch: m.branch });
        break;
      case "view/gap":
        if (live) void this.fillGap(params.after, params.next).catch((e) => this.emit("log", `gap fill failed: ${e}`));
        break;
      default:
        break; // session/goalChanged, session/started, unknown future events: ignored
    }
  }

  // ---------- commands ----------

  private requireSession(): string {
    if (!this.state.sessionId) throw new Error("No active conversation");
    return this.state.sessionId;
  }

  async sendTurn(input: TurnInputPart[], displayText: string, ifBusy: "queue" | "steer" | "replace" = "queue"): Promise<TurnStartResult> {
    if (!this.state.sessionId) await this.startNew();
    const sessionId = this.requireSession();
    const params: Record<string, unknown> = { commandId: uuid7(), sessionId, input, ifBusy };
    if (displayText && displayText !== input.find((p) => p.type === "text")?.text) params.displayText = displayText;
    if (this.state.meta.reasoningEffort) params.reasoningEffort = this.state.meta.reasoningEffort;
    const r = await this.host.request<TurnStartResult>("turn/start", params);
    if (r.disposition === "queued") {
      this.state.meta.queuedTurns.push({ turnId: r.turnId, text: displayText });
      this.patchMeta({ queuedTurns: this.state.meta.queuedTurns });
    } else if (r.disposition === "started" && !this.state.meta.running) {
      this.patchMeta({ running: true, activeTurnId: r.turnId });
    }
    return r;
  }

  async interrupt(retract = false) {
    const sessionId = this.requireSession();
    await this.host.request("turn/interrupt", { commandId: uuid7(), sessionId, retract });
  }

  async unqueue(turnId: string) {
    const sessionId = this.requireSession();
    await this.host.request("turn/unqueue", { commandId: uuid7(), sessionId, turnId });
  }

  async decideApproval(approvalId: string, choiceId: string, requirementId: { approvalId: string; sourceIndex: number }, feedback?: string) {
    const sessionId = this.requireSession();
    const params: Record<string, unknown> = { commandId: uuid7(), sessionId, approvalId, choiceId, requirementId };
    if (feedback) params.feedback = feedback;
    return this.host.request<ApprovalDecideResult>("approval/decide", params);
  }

  async answerUserInput(userInputId: string, answers: UserInputAnswer[]) {
    const sessionId = this.requireSession();
    await this.host.request("userInput/answer", { commandId: uuid7(), sessionId, userInputId, answers });
  }

  async cancelUserInput(userInputId: string) {
    const sessionId = this.requireSession();
    await this.host.request("userInput/cancel", { commandId: uuid7(), sessionId, userInputId, reason: "cancelled by user" });
  }

  async setModel(modelId: string) {
    this.opts.modelId = modelId;
    if (!this.state.sessionId) {
      this.patchMeta({ modelId });
      return;
    }
    await this.host.request("session/setModel", { commandId: uuid7(), sessionId: this.state.sessionId, model: { modelId } });
  }

  async setApprovalMode(mode: ApprovalMode) {
    this.opts.approvalMode = mode;
    if (!this.state.sessionId) {
      this.patchMeta({ approvalMode: mode });
      return;
    }
    await this.host.request("session/setApprovalMode", { commandId: uuid7(), sessionId: this.state.sessionId, mode });
  }

  setReasoningEffort(effort: ReasoningEffort | null) {
    this.opts.reasoningEffort = effort;
    this.patchMeta({ reasoningEffort: effort });
  }

  async compact() {
    const sessionId = this.requireSession();
    await this.host.request("session/compact", { commandId: uuid7(), sessionId });
  }

  async runShell(command: string) {
    if (!this.state.sessionId) await this.startNew();
    const sessionId = this.requireSession();
    return this.host.request<SessionUserShellResult>("session/userShell", { commandId: uuid7(), sessionId, command });
  }

  async listModels(): Promise<ModelCatalogEntry[]> {
    const r = await this.host.request<ModelListResult>("model/list", this.state.sessionId ? { sessionId: this.state.sessionId } : {});
    return r.models;
  }

  async listSessions(limit = 50): Promise<SessionSummary[]> {
    const r = await this.host.request<SessionListResult>("session/list", { workspaceRoot: this.workspaceRoot, limit });
    const out: SessionSummary[] = r.sessions.map((s) => ({
      sessionId: s.sessionId,
      title: "",
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      turnCount: s.turnCount,
      modelId: s.modelId,
      status: s.status,
    }));
    // Titles come from the first user message; read the most recent handful in parallel.
    await Promise.all(
      out.slice(0, 20).map(async (s) => {
        try {
          const rd = await this.host.request<SessionReadResult>("session/read", { sessionId: s.sessionId, excludeItems: false });
          const first = (rd.history.items ?? rd.history.snapshot?.state.items ?? []).find((i) => i.kind === "userMessage");
          const t = (first?.displayText ?? first?.text ?? "").replace(/\s+/g, " ").trim();
          s.title = t.length > 80 ? t.slice(0, 79) + "…" : t;
        } catch {
          /* leave title empty */
        }
      }),
    );
    return out;
  }

  describeError(e: unknown): string {
    if (e instanceof JsonRpcError) {
      switch (e.kind) {
        case "sessionInUse":
          return "This session is open in another Muse host (for example the muse TUI or another window). Close it there first.";
        case "sessionNotFound":
          return "That session no longer exists.";
        default:
          return e.rpc.message;
      }
    }
    return e instanceof Error ? e.message : String(e);
  }

  dispose() {
    this.disposed = true;
    this.detach();
    this.host.off("status", this.onHostStatus);
    this.removeAllListeners();
  }
}

export type { UnframedViewNotification };
