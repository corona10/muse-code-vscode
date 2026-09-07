import type { ApprovalMode, ApprovalRequestParams, Item, ModelCatalogEntry, ReasoningEffort, UserInputAnswer, UserInputRequestParams } from "../msp/msp";
import type { EditorContext, FromWebview, SessionSummary, ToWebview, UiConfig, UiState } from "../protocol";
import { escapeHtml, renderMarkdown } from "./markdown";

declare const acquireVsCodeApi: () => { postMessage(m: FromWebview): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

// ---------- state ----------
interface PendingImage {
  mediaType: string;
  base64Data: string;
  dataUrl: string;
}
const S = {
  config: null as UiConfig | null,
  state: null as UiState | null,
  editorCtx: null as EditorContext | null,
  editorCtxEnabled: true,
  images: [] as PendingImage[],
  sessions: null as SessionSummary[] | null,
  models: null as ModelCatalogEntry[] | null,
  expanded: new Set<string>(),
  history: [] as string[],
  histIdx: -1,
  popup: null as null | "slash" | "model" | "mode" | "effort" | "files",
  slashFilter: "",
  slashIdx: 0,
  feedbackFor: null as null | { approvalId: string; choiceId: string },
  userInputDraft: {} as Record<string, Record<string, { labels: string[]; note: string }>>,
};
const persisted = vscode.getState() ?? {};
S.history = persisted.history ?? [];
S.editorCtxEnabled = persisted.editorCtxEnabled ?? true;

function persist(extra: Record<string, unknown> = {}) {
  const prev = vscode.getState() ?? {};
  vscode.setState({ ...prev, history: S.history.slice(-100), editorCtxEnabled: S.editorCtxEnabled, draft: input.value, ...extra });
}

// ---------- DOM helpers ----------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
const icon = (name: string, cls = "") => h("i", { class: `codicon codicon-${name} ${cls}` });
const nodes = (...children: Child[]): (Node | string)[] => children.filter((c): c is Node | string => !!c);

// ---------- layout ----------
const app = document.getElementById("app")!;
const header = h("div", { class: "header" });
const body = h("div", { class: "body" });
const welcome = h("div", { class: "welcome" });
const transcript = h("div", { class: "transcript" });
const pending = h("div", { class: "pending" });
const queued = h("div", { class: "queued" });
const live = h("div", { class: "live" });
const todoBox = h("div", { class: "todo" });
const chips = h("div", { class: "chips" });
const input = h("textarea", { class: "input", rows: 1, placeholder: "Ask Muse anything… (@ files, / commands, ! shell)" });
const footer = h("div", { class: "composer-footer" });
const composer = h("div", { class: "composer" }, todoBox, chips, input, footer);
const popup = h("div", { class: "popup", hidden: true });
const toasts = h("div", { class: "toasts" });
const overlay = h("div", { class: "overlay", hidden: true });
body.append(welcome, transcript, pending, queued, live);
app.append(header, body, composer, popup, toasts, overlay);
input.value = persisted.draft ?? "";

// ---------- header ----------
function renderHeader() {
  header.replaceChildren();
  const title = S.state?.meta.title ?? "Muse Code";
  header.append(
    h("div", { class: "header-title", title }, icon("sparkle"), h("span", {}, title)),
    h("div", { class: "header-actions" },
      h("button", { class: "icon-btn", title: "Past conversations (/resume)", onclick: openSessions }, icon("history")),
      h("button", { class: "icon-btn", title: "New chat", onclick: () => post({ type: "newConversation" }) }, icon("add")),
      h("button", { class: `icon-btn ${S.config?.focusView ? "active" : ""}`, title: "Focus view (ctrl+alt+f)", onclick: () => post({ type: "toggleFocusView" }) }, icon("eye")),
      S.config?.location === "sidebar"
        ? h("button", { class: "icon-btn", title: "Open in new tab", onclick: () => post({ type: "command", command: "muse-vscode.editor.open" }) }, icon("link-external"))
        : h("button", { class: "icon-btn", title: "Open in side bar", onclick: () => post({ type: "command", command: "muse-vscode.sidebar.open" }) }, icon("layout-sidebar-right")),
    ),
  );
}

// ---------- welcome ----------
function renderWelcome() {
  const st = S.state;
  const show = !!st && st.items.length === 0 && !S.config?.hideOnboarding;
  welcome.hidden = !show;
  if (!show) return;
  welcome.replaceChildren(
    h("div", { class: "welcome-art" }, icon("sparkle", "big")),
    h("h2", {}, "Muse Code"),
    h("p", { class: "muted" }, "Your AI coding partner, right in VS Code."),
    h("ul", { class: "checklist" },
      h("li", {}, icon("file-code"), h("span", { html: "Select code in an editor, then ask about it — the selection travels with your prompt." })),
      h("li", {}, icon("mention"), h("span", { html: "Type <kbd>@</kbd> to mention files, or press <kbd>Alt+K</kbd> in an editor." })),
      h("li", {}, icon("terminal"), h("span", { html: "Start a line with <kbd>!</kbd> to run a shell command yourself." })),
      h("li", {}, icon("history"), h("span", { html: "Type <kbd>/resume</kbd> to pick up a past conversation." })),
    ),
    h("button", { class: "link-btn", onclick: () => post({ type: "setConfig", key: "hideOnboarding", value: true }) }, "Hide this"),
  );
}

// ---------- transcript ----------
const itemEls = new Map<string, HTMLElement>();
const HIDDEN_IN_FOCUS = new Set(["toolCall", "reasoning", "compaction", "subagent", "workflow", "reminderChild"]);

function toolSummary(item: Item): { label: string; path?: string; line?: number } {
  let args: any = null;
  try {
    args = item.args ? JSON.parse(item.args) : null;
  } catch {
    /* almost-JSON */
  }
  const tool = item.tool ?? "tool";
  if (args && typeof args === "object") {
    if (typeof args.command === "string") return { label: args.command.split("\n")[0].slice(0, 200) };
    for (const k of ["path", "file_path", "filePath", "target_file", "file", "filename"]) {
      if (typeof args[k] === "string") return { label: args[k], path: args[k], line: typeof args.line === "number" ? args.line : undefined };
    }
    if (typeof args.pattern === "string") return { label: args.pattern };
    if (typeof args.query === "string") return { label: args.query };
    if (typeof args.description === "string") return { label: args.description };
    if (typeof args.url === "string") return { label: args.url };
  }
  return { label: item.args ? item.args.slice(0, 120) : tool };
}

function statusIcon(status: string, kind?: string) {
  if (status === "inProgress") return icon("loading", "spin");
  if (status === "completed") return icon("check", "ok");
  if (status === "failed" || status === "rejected" || status === "timedOut") return icon("error", "bad");
  if (status === "cancelled") return icon("circle-slash", "muted");
  return icon("circle-outline", "muted");
}

function renderItem(item: Item): HTMLElement {
  const el = h("div", { class: `item item-${item.kind} status-${item.status}`, dataset: { id: item.itemId } });
  const expanded = S.expanded.has(item.itemId);
  switch (item.kind) {
    case "userMessage": {
      const text = item.displayText ?? item.text ?? "";
      el.append(h("div", { class: `bubble ${item.retracted ? "retracted" : ""}` }, h("div", { class: "bubble-text", html: renderMarkdown(text) }), item.attachments?.length ? h("div", { class: "attachments" }, icon("file-media"), `${item.attachments.length} image${item.attachments.length > 1 ? "s" : ""}`) : null, item.steered ? h("span", { class: "tag" }, "steered") : null));
      break;
    }
    case "agentMessage":
      el.append(h("div", { class: "md agent-text", html: renderMarkdown(item.text ?? "") }));
      if (item.truncated) el.append(h("div", { class: "muted small" }, "(output truncated)"));
      break;
    case "reasoning": {
      const text = (item.summary?.filter(Boolean).join("\n\n") || item.text || "").trim();
      const head = h("div", { class: "row-head", onclick: () => toggle(item.itemId) }, icon(expanded ? "chevron-down" : "chevron-right"), icon("lightbulb"), h("span", { class: "row-label" }, item.status === "inProgress" ? "Thinking…" : "Thought"), statusIcon(item.status));
      el.append(head);
      if (expanded && text) el.append(h("div", { class: "row-body md", html: renderMarkdown(text) }));
      break;
    }
    case "toolCall": {
      const sum = toolSummary(item);
      const head = h("div", { class: "row-head", onclick: () => toggle(item.itemId) },
        icon(expanded ? "chevron-down" : "chevron-right"),
        icon(toolIcon(item.tool)),
        h("span", { class: "row-tool" }, item.tool ?? "tool"),
        h("span", { class: "row-label mono", title: sum.label }, sum.label),
        item.background ? h("span", { class: "tag" }, "background") : null,
        statusIcon(item.status),
      );
      el.append(head);
      if (expanded) {
        const bodyEl = h("div", { class: "row-body" });
        if (sum.path) bodyEl.append(h("div", { class: "row-actions" }, h("button", { class: "link-btn", onclick: () => post({ type: "openFile", path: sum.path!, line: sum.line }) }, icon("go-to-file"), " Open"), h("button", { class: "link-btn", onclick: () => post({ type: "openDiff", path: sum.path! }) }, icon("diff"), " View changes")));
        bodyEl.append(h("div", { class: "kv" }, "Arguments"), h("pre", { class: "args" }, prettyJson(item.args ?? "")));
        if (item.visibleOutput) bodyEl.append(h("div", { class: "kv" }, "Output"), h("pre", { class: "output" }, item.visibleOutput));
        if (item.failureReason) bodyEl.append(h("div", { class: "kv bad" }, `Failed: ${item.failureReason}`));
        el.append(bodyEl);
      } else if (item.status === "inProgress" && item.visibleOutput) {
        el.append(h("pre", { class: "output preview" }, item.visibleOutput.slice(-400)));
      }
      break;
    }
    case "userShell": {
      el.append(h("div", { class: "row-head", onclick: () => toggle(item.itemId) }, icon(expanded ? "chevron-down" : "chevron-right"), icon("terminal"), h("span", { class: "row-label mono" }, `! ${item.commandText ?? ""}`), item.exitCode !== undefined ? h("span", { class: `tag ${item.exitCode === 0 ? "" : "bad"}` }, `exit ${item.exitCode}`) : null, statusIcon(item.status)));
      if (expanded || item.status === "inProgress") el.append(h("pre", { class: "output" }, item.visibleOutput ?? ""));
      break;
    }
    case "subagent": {
      el.append(h("div", { class: "row-head", onclick: () => toggle(item.itemId) }, icon(expanded ? "chevron-down" : "chevron-right"), icon("organization"), h("span", { class: "row-tool" }, item.role ?? "subagent"), h("span", { class: "row-label" }, item.objective ?? ""), statusIcon(item.status)));
      if (expanded) el.append(h("div", { class: "row-body md", html: renderMarkdown(item.result?.text || item.result?.summary || item.fallbackText || "(no result yet)") }));
      break;
    }
    case "compaction":
      el.append(h("div", { class: "system-row" }, icon("fold"), `Context compacted${item.tokensBefore && item.tokensAfter ? ` (${fmtTokens(item.tokensBefore)} → ${fmtTokens(item.tokensAfter)})` : ""}${item.reason ? ` · ${item.reason}` : ""}`));
      break;
    default:
      el.append(h("div", { class: "system-row" }, icon("circle-outline"), `${item.kind} · ${item.status}${item.fallbackText ? ` · ${item.fallbackText}` : ""}`));
  }
  return el;
}

function toolIcon(tool?: string): string {
  const t = (tool ?? "").toLowerCase();
  if (/bash|shell|exec|run/.test(t)) return "terminal";
  if (/read|cat|view|open/.test(t)) return "eye";
  if (/write|edit|patch|create|replace|apply/.test(t)) return "edit";
  if (/grep|search|find|glob|ls|list/.test(t)) return "search";
  if (/web|fetch|http|browser/.test(t)) return "globe";
  if (/todo|task/.test(t)) return "checklist";
  if (/agent|spawn/.test(t)) return "organization";
  return "tools";
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));

function toggle(id: string) {
  if (S.expanded.has(id)) S.expanded.delete(id);
  else S.expanded.add(id);
  const it = S.state?.items.find((i) => i.itemId === id);
  if (it) upsertItemEl(it);
}

function upsertItemEl(item: Item) {
  const el = renderItem(item);
  const prev = itemEls.get(item.itemId);
  if (prev) prev.replaceWith(el);
  else transcript.append(el);
  itemEls.set(item.itemId, el);
}

function renderTranscript() {
  transcript.replaceChildren();
  itemEls.clear();
  for (const it of S.state?.items ?? []) upsertItemEl(it);
  renderWelcome();
  scrollToBottom(true);
}

let deltaRaf = 0;
const dirtyDeltas = new Set<string>();
function applyDelta(itemId: string, field: string, delta: string) {
  const it = S.state?.items.find((i) => i.itemId === itemId);
  if (!it) return;
  if (field === "text") it.text = (it.text ?? "") + delta;
  else if (field === "output") it.visibleOutput = (it.visibleOutput ?? "") + delta;
  else if (field.startsWith("summary.")) {
    const n = Number(field.slice(8));
    it.summary = it.summary ?? [];
    it.summary[n] = (it.summary[n] ?? "") + delta;
  }
  dirtyDeltas.add(itemId);
  if (!deltaRaf) deltaRaf = requestAnimationFrame(flushDeltas);
}
function flushDeltas() {
  deltaRaf = 0;
  for (const id of dirtyDeltas) {
    const it = S.state?.items.find((i) => i.itemId === id);
    if (it) upsertItemEl(it);
  }
  dirtyDeltas.clear();
  renderLive();
  scrollToBottom();
}

let stickToBottom = true;
body.addEventListener("scroll", () => {
  stickToBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
});
function scrollToBottom(force = false) {
  if (force || stickToBottom) body.scrollTop = body.scrollHeight;
}

// ---------- live indicator / todo / queued ----------
function renderLive() {
  const st = S.state;
  live.replaceChildren();
  if (!st?.meta.running) return;
  const open = [...st.items].reverse().find((i) => i.status === "inProgress" && i.kind !== "userMessage");
  if (open?.kind === "agentMessage") return;
  const label = open?.kind === "toolCall" ? `Running ${open.tool ?? "tool"}…` : open?.kind === "subagent" ? `Subagent ${open.role ?? ""} working…` : "Thinking…";
  live.append(icon("loading", "spin"), h("span", {}, label), h("span", { class: "muted small" }, " · Esc to interrupt"));
}

function renderTodo() {
  const todo = S.state?.meta.todo ?? [];
  todoBox.hidden = todo.length === 0;
  if (!todo.length) return;
  const done = todo.filter((t) => t.status === "completed").length;
  const open = S.expanded.has("__todo");
  todoBox.replaceChildren(...nodes(
    h("div", { class: "row-head", onclick: () => toggle("__todo") }, icon(open ? "chevron-down" : "chevron-right"), icon("checklist"), h("span", { class: "row-label" }, `Tasks ${done}/${todo.length}`), h("span", { class: "muted small" }, todo.find((t) => t.status === "inProgress")?.activeForm ?? "")),
    open ? h("ul", { class: "todo-list" }, ...todo.map((t) => h("li", { class: `todo-${t.status}` }, icon(t.status === "completed" ? "pass-filled" : t.status === "inProgress" ? "loading" : t.status === "cancelled" ? "circle-slash" : "circle-large-outline", t.status === "inProgress" ? "spin" : ""), t.text))) : null,
  ));
}

function renderQueued() {
  const q = S.state?.meta.queuedTurns ?? [];
  queued.replaceChildren(...q.map((t) => h("div", { class: "queued-row" }, icon("clock"), h("span", { class: "row-label" }, t.text || "(queued prompt)"), h("button", { class: "icon-btn", title: "Remove from queue", onclick: () => post({ type: "unqueue", turnId: t.turnId }) }, icon("close")))));
}

// ---------- approvals & user input ----------
function subjectSummary(a: ApprovalRequestParams): { title: string; detail: string } {
  const s = a.subject;
  switch (s.kind) {
    case "shell":
      return { title: `Run command`, detail: s.command ?? a.rawArgs };
    case "fileAccess":
      return { title: `${s.access ?? "Access"} file`, detail: s.path ?? a.rawArgs };
    case "network":
      return { title: `Network access`, detail: [s.protocol, s.host, s.port].filter(Boolean).join(":") || s.target || a.rawArgs };
    case "process":
      return { title: `Process`, detail: s.target ?? a.rawArgs };
    default:
      return { title: `Use tool ${s.toolName ?? a.toolName}`, detail: s.target ?? a.rawArgs };
  }
}

function renderPending() {
  pending.replaceChildren();
  for (const a of S.state?.approvals ?? []) pending.append(renderApproval(a));
  for (const u of S.state?.userInputs ?? []) pending.append(renderUserInput(u));
  scrollToBottom();
}

function renderApproval(a: ApprovalRequestParams): HTMLElement {
  const { title, detail } = subjectSummary(a);
  const card = h("div", { class: "card approval" });
  card.append(
    h("div", { class: "card-head" }, icon("shield"), h("span", {}, `${title} · `), h("span", { class: "mono" }, a.toolName), a.protectedWrite ? h("span", { class: "tag bad" }, "protected") : null, a.judgeEscalated ? h("span", { class: "tag" }, "escalated") : null),
    h("pre", { class: "args" }, detail),
  );
  const stages = a.subject.stages;
  if (stages && stages.length > 1) card.append(h("div", { class: "muted small" }, `Stage ${a.currentRequirementId.sourceIndex + 1} of ${stages.length}`));
  const fb = S.feedbackFor?.approvalId === a.approvalId ? S.feedbackFor : null;
  const btns = h("div", { class: "choices" });
  for (const c of a.availableChoices) {
    const primary = c.decision === "approved";
    const danger = c.decision.startsWith("denied") || c.decision === "abort";
    btns.append(
      h("button", {
        class: `btn ${primary ? "primary" : danger ? "danger" : ""}`,
        title: c.rulePreview ?? "",
        onclick: () => {
          if (c.acceptsFeedback) {
            S.feedbackFor = { approvalId: a.approvalId, choiceId: c.choiceId };
            renderPending();
          } else decide(a, c.choiceId);
        },
      }, c.label, c.scope !== "once" ? h("span", { class: "muted small" }, ` (${c.scope === "session" ? "this session" : "always"})`) : null),
    );
  }
  card.append(btns);
  if (fb) {
    const ta = h("textarea", { class: "feedback", rows: 2, placeholder: "Tell Muse what to do instead (optional)" });
    card.append(ta, h("div", { class: "choices" }, h("button", { class: "btn danger", onclick: () => decide(a, fb.choiceId, ta.value) }, "Send"), h("button", { class: "btn", onclick: () => { S.feedbackFor = null; renderPending(); } }, "Cancel")));
    setTimeout(() => ta.focus(), 0);
  }
  return card;
}

function decide(a: ApprovalRequestParams, choiceId: string, feedback?: string) {
  S.feedbackFor = null;
  post({ type: "decideApproval", approvalId: a.approvalId, choiceId, requirementId: a.currentRequirementId, feedback: feedback?.trim() || undefined });
}

function renderUserInput(u: UserInputRequestParams): HTMLElement {
  const draft = (S.userInputDraft[u.userInputId] ??= {});
  const card = h("div", { class: "card userinput" }, h("div", { class: "card-head" }, icon("question"), h("span", {}, "Muse has a question")));
  for (const q of u.questions) {
    const d = (draft[q.id] ??= { labels: [], note: "" });
    const multi = q.selection.mode === "multiple";
    const qEl = h("div", { class: "question" }, h("div", { class: "q-header" }, q.header), h("div", { class: "q-text md", html: renderMarkdown(q.question) }));
    for (const o of q.options) {
      const selected = d.labels.includes(o.label);
      qEl.append(
        h("button", {
          class: `option ${selected ? "selected" : ""}`,
          onclick: () => {
            if (multi) d.labels = selected ? d.labels.filter((l) => l !== o.label) : [...d.labels, o.label];
            else d.labels = [o.label];
            renderPending();
          },
        }, icon(multi ? (selected ? "check" : "circle-large-outline") : selected ? "circle-filled" : "circle-large-outline"), h("span", { class: "option-label" }, o.label), o.description ? h("span", { class: "muted small" }, o.description) : null),
      );
      if (o.preview && selected) qEl.append(h("pre", { class: "args" }, o.preview.content));
    }
    const note = h("input", { class: "note", placeholder: "Other / notes (optional)", value: d.note });
    note.addEventListener("input", () => (d.note = note.value));
    qEl.append(note);
    card.append(qEl);
  }
  card.append(
    h("div", { class: "choices" },
      h("button", { class: "btn primary", onclick: () => {
        const answers: UserInputAnswer[] = u.questions.map((q) => {
          const d = draft[q.id];
          const a: UserInputAnswer = { questionId: q.id };
          if (q.selection.mode === "multiple") a.selectedLabels = d.labels;
          else if (d.labels[0]) a.selectedLabel = d.labels[0];
          if (d.note.trim()) {
            if (!d.labels.length) a.freeText = d.note.trim();
            else a.note = d.note.trim();
          }
          return a;
        });
        post({ type: "answerUserInput", userInputId: u.userInputId, answers });
      } }, "Submit"),
      h("button", { class: "btn", onclick: () => post({ type: "cancelUserInput", userInputId: u.userInputId }) }, "Skip"),
    ),
  );
  return card;
}

// ---------- composer ----------
const MODE_LABELS: Record<string, string> = { onRequest: "On request", promptUnmatched: "Prompt unmatched", denyUnmatched: "Deny unmatched", allowAll: "Allow all" };
const EFFORTS: (ReasoningEffort | null)[] = [null, "none", "minimal", "low", "medium", "high", "xhigh", "ultra"];

function modes(): ApprovalMode[] {
  const m: ApprovalMode[] = ["onRequest", "promptUnmatched", "denyUnmatched"];
  if (S.config?.allowAllEnabled) m.push("allowAll");
  return m;
}

function renderChips() {
  chips.replaceChildren();
  const ctx = S.editorCtx;
  if (ctx && S.config?.includeEditorContext) {
    const label = ctx.selection ? `${basename(ctx.path)}:${ctx.selection.startLine}${ctx.selection.endLine !== ctx.selection.startLine ? `-${ctx.selection.endLine}` : ""}` : basename(ctx.path);
    chips.append(h("button", { class: `chip ${S.editorCtxEnabled ? "" : "off"}`, title: `${S.editorCtxEnabled ? "Attached" : "Not attached"}: ${ctx.path}. Click to toggle.`, onclick: () => { S.editorCtxEnabled = !S.editorCtxEnabled; persist(); renderChips(); } }, icon(ctx.selection ? "selection" : "file"), label));
  }
  S.images.forEach((img, i) => chips.append(h("span", { class: "chip img" }, h("img", { src: img.dataUrl, alt: "attachment" }), h("button", { class: "icon-btn", title: "Remove", onclick: () => { S.images.splice(i, 1); renderChips(); } }, icon("close")))));
  const files = S.state?.changedFiles ?? [];
  if (files.length) {
    const open = S.expanded.has("__files");
    chips.append(h("button", { class: "chip", onclick: () => toggle("__files") }, icon("diff-multiple"), `${files.length} file${files.length > 1 ? "s" : ""} changed`, icon(open ? "chevron-up" : "chevron-down")));
    if (open) chips.append(h("div", { class: "files-list" }, ...files.map((f) => h("div", { class: "file-row" }, h("button", { class: "link-btn mono", onclick: () => post({ type: "openFile", path: f }) }, f), h("button", { class: "icon-btn", title: "View changes", onclick: () => post({ type: "openDiff", path: f }) }, icon("diff"))))));
  }
}
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

function renderFooter() {
  footer.replaceChildren();
  const m = S.state?.meta;
  const cu = m?.contextUsage;
  const pct = cu?.windowTokens ? Math.min(100, Math.round((cu.usedTokens / cu.windowTokens) * 100)) : null;
  footer.append(...nodes(
    h("button", { class: "pill", title: "Approval mode (Shift+Tab to cycle)", onclick: () => openPopup("mode") }, icon("shield"), MODE_LABELS[m?.approvalMode ?? ""] ?? "Default"),
    h("button", { class: "pill", title: "Model", onclick: () => openPopup("model") }, icon("chip"), m?.modelId ?? "default model"),
    h("button", { class: "pill", title: "Reasoning effort", onclick: () => openPopup("effort") }, icon("lightbulb"), m?.reasoningEffort ?? "effort"),
    pct !== null ? h("span", { class: `meter pressure-${cu!.pressure}`, title: `Context: ${fmtTokens(cu!.usedTokens)} / ${fmtTokens(cu!.windowTokens!)} tokens` }, h("span", { class: "meter-bar", style: `width:${pct}%` }), h("span", { class: "meter-text" }, `${pct}%`)) : null,
    h("span", { class: "spacer" }),
    m?.hostStatus && m.hostStatus !== "ready" ? h("span", { class: `tag ${m.hostStatus === "failed" ? "bad" : ""}`, title: m.hostMessage ?? "" }, m.hostStatus === "starting" ? "starting…" : m.hostStatus) : null,
    m?.running
      ? h("button", { class: "btn danger send", title: "Interrupt (Esc)", onclick: () => post({ type: "interrupt" }) }, icon("debug-stop"), " Stop")
      : h("button", { class: "btn primary send", title: S.config?.useCtrlEnterToSend ? "Send (Ctrl/Cmd+Enter)" : "Send (Enter)", onclick: submit }, icon("send")),
  ));
}

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 240) + "px";
}

function submit() {
  const raw = input.value;
  const text = raw.trim();
  if (!text && S.images.length === 0) return;
  if (text.startsWith("/") && runSlash(text)) {
    clearInput();
    return;
  }
  if (text.startsWith("!") && text.length > 1) {
    post({ type: "runShell", command: text.slice(1).trim() });
    remember(text);
    clearInput();
    return;
  }
  const running = !!S.state?.meta.running;
  post({ type: "send", payload: { text, images: S.images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), includeEditorContext: S.editorCtxEnabled && !!S.config?.includeEditorContext, ifBusy: running ? "queue" : undefined } });
  remember(text);
  clearInput();
}
function remember(text: string) {
  S.history = S.history.filter((x) => x !== text).concat(text).slice(-100);
  S.histIdx = -1;
}
function clearInput() {
  input.value = "";
  S.images = [];
  autosize();
  renderChips();
  persist();
  // A slash command may have just opened another popup (model/mode/effort); only the slash menu itself goes away.
  if (S.popup === "slash") closePopup();
}

// ---------- slash commands ----------
const SLASH: { cmd: string; desc: string; run: () => void }[] = [
  { cmd: "/new", desc: "Start a new conversation", run: () => post({ type: "newConversation" }) },
  { cmd: "/clear", desc: "Start a new conversation", run: () => post({ type: "newConversation" }) },
  { cmd: "/resume", desc: "Resume a past conversation", run: openSessions },
  { cmd: "/model", desc: "Choose the model", run: () => openPopup("model") },
  { cmd: "/mode", desc: "Choose the approval mode", run: () => openPopup("mode") },
  { cmd: "/effort", desc: "Choose the reasoning effort", run: () => openPopup("effort") },
  { cmd: "/compact", desc: "Compact the conversation context", run: () => post({ type: "compact" }) },
  { cmd: "/focus", desc: "Toggle focus view", run: () => post({ type: "toggleFocusView" }) },
  { cmd: "/terminal", desc: "Open Muse in a terminal", run: () => post({ type: "command", command: "muse-vscode.terminal.open" }) },
  { cmd: "/login", desc: "Log in to Muse", run: () => post({ type: "command", command: "muse-vscode.login" }) },
  { cmd: "/logout", desc: "Log out of Muse", run: () => post({ type: "command", command: "muse-vscode.logout" }) },
  { cmd: "/logs", desc: "Show extension logs", run: () => post({ type: "command", command: "muse-vscode.showLogs" }) },
  { cmd: "/help", desc: "Open the walkthrough", run: () => post({ type: "command", command: "muse-vscode.openWalkthrough" }) },
];
function runSlash(text: string): boolean {
  const word = text.split(/\s+/)[0].toLowerCase();
  const match = SLASH.find((s) => s.cmd === word) ?? (S.popup === "slash" ? slashSelected() : undefined);
  if (!match) return false;
  match.run();
  return true;
}
const slashMatches = () => SLASH.filter((s) => s.cmd.startsWith(S.slashFilter.toLowerCase()));
const slashSelected = () => slashMatches()[S.slashIdx];
/** Moves the highlighted slash command by `delta`, wrapping around, and re-renders the popup. */
function moveSlash(delta: number) {
  const n = slashMatches().length;
  if (!n) return;
  S.slashIdx = (S.slashIdx + delta + n) % n;
  openPopup("slash");
}

// ---------- popups ----------
function openPopup(kind: NonNullable<typeof S.popup>) {
  S.popup = kind;
  popup.hidden = false;
  popup.replaceChildren();
  if (kind === "slash") {
    const list = slashMatches();
    if (!list.length) return closePopup();
    S.slashIdx = Math.min(S.slashIdx, list.length - 1);
    popup.append(...list.map((s, i) => h("div", { class: `popup-row ${i === S.slashIdx ? "active" : ""}`, onclick: () => { s.run(); clearInput(); } }, h("span", { class: "mono" }, s.cmd), h("span", { class: "muted" }, s.desc))));
    popup.querySelector(".popup-row.active")?.scrollIntoView({ block: "nearest" });
  } else if (kind === "mode") {
    popup.append(h("div", { class: "popup-title" }, "Approval mode"));
    // "Allow all" is always listed; when the setting is off, picking it asks the host for a one-time confirmation that enables it.
    const enabled = !!S.config?.allowAllEnabled;
    const all: ApprovalMode[] = enabled ? modes() : [...modes(), "allowAll"];
    for (const m of all) {
      const locked = m === "allowAll" && !enabled;
      popup.append(h("div", { class: `popup-row ${S.state?.meta.approvalMode === m ? "active" : ""}`, onclick: () => { post({ type: "setApprovalMode", mode: m }); closePopup(); } }, h("span", {}, MODE_LABELS[m], locked ? h("span", { class: "tag bad" }, "confirm to enable") : null), h("span", { class: "muted" }, MODE_DESC[m])));
    }
  } else if (kind === "effort") {
    popup.append(h("div", { class: "popup-title" }, "Reasoning effort"));
    for (const e of EFFORTS) popup.append(h("div", { class: `popup-row ${(S.state?.meta.reasoningEffort ?? null) === e ? "active" : ""}`, onclick: () => { post({ type: "setReasoningEffort", effort: e }); closePopup(); } }, e ?? "Muse default"));
  } else if (kind === "model") {
    popup.append(h("div", { class: "popup-title" }, "Model"));
    if (!S.models) {
      popup.append(h("div", { class: "muted pad" }, "Loading…"));
      post({ type: "listModels" });
    } else for (const m of S.models) popup.append(h("div", { class: `popup-row ${m.isActive || m.modelId === S.state?.meta.modelId ? "active" : ""}`, onclick: () => { post({ type: "setModel", modelId: m.modelId }); closePopup(); } }, h("span", {}, m.displayLabel, m.isDefault ? h("span", { class: "tag" }, "default") : null), h("span", { class: "muted small" }, m.description ?? (m.contextLimit ? `${fmtTokens(m.contextLimit)} ctx` : ""))));
  }
}
const MODE_DESC: Record<string, string> = { onRequest: "Ask when a tool requests approval", promptUnmatched: "Ask unless a policy rule allows it", denyUnmatched: "Deny unless a policy rule allows it", allowAll: "Never ask (dangerous)" };
function closePopup() {
  S.popup = null;
  popup.hidden = true;
}
document.addEventListener("click", (e) => {
  // composedPath() is captured at dispatch time, so it still holds the popup even if the click re-rendered it.
  const path = e.composedPath();
  if (!popup.hidden && !path.includes(popup) && !path.includes(footer) && e.target !== input) closePopup();
});

// ---------- sessions overlay ----------
function openSessions() {
  overlay.hidden = false;
  overlay.replaceChildren(h("div", { class: "overlay-head" }, h("span", {}, "Past conversations"), h("button", { class: "icon-btn", onclick: closeOverlay }, icon("close"))), h("div", { class: "muted pad" }, "Loading…"));
  S.sessions = null;
  post({ type: "listSessions" });
}
function renderSessions() {
  if (overlay.hidden) return;
  overlay.replaceChildren(h("div", { class: "overlay-head" }, h("span", {}, "Past conversations"), h("button", { class: "icon-btn", onclick: closeOverlay }, icon("close"))));
  const list = S.sessions ?? [];
  if (!list.length) overlay.append(h("div", { class: "muted pad" }, "No sessions recorded for this workspace yet."));
  for (const s of list) {
    overlay.append(h("div", { class: `session-row ${s.sessionId === S.state?.sessionId ? "active" : ""}`, onclick: () => { post({ type: "resumeSession", sessionId: s.sessionId }); closeOverlay(); } }, h("div", { class: "session-title" }, s.title || "(untitled)"), h("div", { class: "muted small" }, `${relTime(s.updatedAt)} · ${s.turnCount} turn${s.turnCount === 1 ? "" : "s"}${s.modelId ? ` · ${s.modelId}` : ""}${s.status === "running" ? " · running" : ""}`)));
  }
}
function closeOverlay() {
  overlay.hidden = true;
}
function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  const m = Math.round(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hh = Math.round(m / 60);
  if (hh < 24) return `${hh}h ago`;
  const dd = Math.round(hh / 24);
  return dd < 7 ? `${dd}d ago` : new Date(iso).toLocaleDateString();
}

// ---------- toasts ----------
function toast(level: "info" | "warning" | "error", message: string, action?: { label: string; command: string }) {
  const t = h("div", { class: `toast ${level}` }, icon(level === "error" ? "error" : level === "warning" ? "warning" : "info"), h("span", { class: "toast-text" }, message), action ? h("button", { class: "btn small", onclick: () => { post({ type: "command", command: action.command }); t.remove(); } }, action.label) : null, h("button", { class: "icon-btn", onclick: () => t.remove() }, icon("close")));
  toasts.append(t);
  if (level === "info") setTimeout(() => t.remove(), 6000);
}

// ---------- input events ----------
input.addEventListener("input", () => {
  autosize();
  persist();
  const v = input.value;
  if (v.startsWith("/") && !v.includes("\n") && !/\s/.test(v)) {
    if (v !== S.slashFilter) S.slashIdx = 0;
    S.slashFilter = v;
    openPopup("slash");
  } else if (S.popup === "slash") closePopup();
});
// IME composition (Korean, Japanese, Chinese…): Enter/Tab/arrows arriving mid-composition must not submit or
// move history, otherwise the IME commits its last syllable into the freshly cleared textarea.
let composing = false;
input.addEventListener("compositionstart", () => (composing = true));
input.addEventListener("compositionend", () => setTimeout(() => (composing = false), 0));
input.addEventListener("keydown", (e) => {
  if (composing || e.isComposing || e.keyCode === 229) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "@" && !e.altKey && !mod) {
    const before = input.value.slice(0, input.selectionStart);
    if (before === "" || /\s$/.test(before)) {
      // let the "@" land, then ask the host for a file picker
      setTimeout(() => post({ type: "pickFile" }), 0);
    }
    return;
  }
  if (e.key === "Escape") {
    if (S.popup) return closePopup();
    if (!overlay.hidden) return closeOverlay();
    if (S.state?.meta.running) post({ type: "interrupt" });
    return;
  }
  if (e.key === "Tab" && e.shiftKey && !S.popup) {
    e.preventDefault();
    const ms = modes();
    const cur = S.state?.meta.approvalMode ?? ms[0];
    post({ type: "setApprovalMode", mode: ms[(ms.indexOf(cur) + 1) % ms.length] });
    return;
  }
  if (S.popup === "slash" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    moveSlash(e.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (S.popup === "slash" && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
    e.preventDefault();
    const sel = slashSelected();
    if (sel) {
      sel.run();
      clearInput();
    }
    return;
  }
  if (e.key === "Enter") {
    const ctrlEnter = !!S.config?.useCtrlEnterToSend;
    if ((ctrlEnter && mod) || (!ctrlEnter && !e.shiftKey && !mod && !e.altKey)) {
      e.preventDefault();
      submit();
    }
    return;
  }
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && S.history.length) {
    const atEdge = e.key === "ArrowUp" ? input.selectionStart === 0 || input.value === "" : input.selectionEnd === input.value.length;
    if (!atEdge) return;
    e.preventDefault();
    if (e.key === "ArrowUp") S.histIdx = S.histIdx < 0 ? S.history.length - 1 : Math.max(0, S.histIdx - 1);
    else S.histIdx = S.histIdx < 0 ? -1 : S.histIdx + 1 >= S.history.length ? -1 : S.histIdx + 1;
    input.value = S.histIdx < 0 ? "" : S.history[S.histIdx];
    autosize();
  }
});
input.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of Array.from(items)) {
    if (!it.type.startsWith("image/")) continue;
    const file = it.getAsFile();
    if (!file) continue;
    e.preventDefault();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      S.images.push({ mediaType: it.type, base64Data: dataUrl.split(",")[1] ?? "", dataUrl });
      renderChips();
    };
    reader.readAsDataURL(file);
  }
});
function insertAtCursor(text: string) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const before = input.value.slice(0, start);
  // a picker opened by a typed "@" inserts the path right after it
  const body = text.startsWith("@") && before.endsWith("@") ? text.slice(1) : text;
  input.value = before + body + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + body.length;
  autosize();
  persist();
  input.focus();
}

// Delegated clicks inside rendered markdown: file links and copy buttons.
app.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const fileLink = t.closest<HTMLElement>(".file-link");
  if (fileLink?.dataset.file) {
    e.preventDefault();
    const m = fileLink.dataset.file.match(/^(.*?)(?:#L(\d+)(?:-(\d+))?)?$/);
    post({ type: "openFile", path: m?.[1] ?? fileLink.dataset.file, line: m?.[2] ? Number(m[2]) : undefined });
    return;
  }
  const copy = t.closest<HTMLElement>("[data-copy]");
  if (copy) {
    post({ type: "copy", text: copy.dataset.copy ?? "" });
    copy.replaceChildren(icon("check"));
    setTimeout(() => copy.replaceChildren(icon("copy")), 1200);
    return;
  }
  const a = t.closest<HTMLAnchorElement>("a[href^='http']");
  if (a) {
    e.preventDefault();
    post({ type: "openExternal", url: a.href });
  }
});

// ---------- message handling ----------
function renderAll() {
  app.classList.toggle("focus-view", !!S.config?.focusView);
  renderHeader();
  renderTranscript();
  renderPending();
  renderQueued();
  renderTodo();
  renderChips();
  renderFooter();
  renderLive();
}

window.addEventListener("message", (ev: MessageEvent<ToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case "init":
      S.config = m.config;
      S.state = m.state;
      persist({ panelState: { workspaceRoot: m.state.workspaceRoot, sessionId: m.state.sessionId } });
      renderAll();
      break;
    case "state":
      S.state = m.state;
      S.feedbackFor = null;
      persist({ panelState: { workspaceRoot: m.state.workspaceRoot, sessionId: m.state.sessionId } });
      renderAll();
      break;
    case "config":
      S.config = m.config;
      app.classList.toggle("focus-view", m.config.focusView);
      renderHeader();
      renderWelcome();
      renderChips();
      renderFooter();
      break;
    case "item": {
      if (!S.state) break;
      const idx = S.state.items.findIndex((i) => i.itemId === m.item.itemId);
      if (idx >= 0) S.state.items[idx] = m.item;
      else S.state.items.push(m.item);
      upsertItemEl(m.item);
      renderWelcome();
      renderLive();
      scrollToBottom();
      break;
    }
    case "delta":
      applyDelta(m.itemId, m.field, m.delta);
      break;
    case "meta":
      if (!S.state) break;
      Object.assign(S.state.meta, m.meta);
      if (m.meta.title !== undefined) renderHeader();
      if (m.meta.todo) renderTodo();
      if (m.meta.queuedTurns) renderQueued();
      renderFooter();
      renderLive();
      if (m.meta.running === false) S.userInputDraft = {};
      break;
    case "approval":
      if (!S.state) break;
      S.state.approvals = S.state.approvals.filter((a) => a.approvalId !== m.approval.approvalId).concat(m.approval);
      renderPending();
      break;
    case "approvalResolved":
      if (!S.state) break;
      S.state.approvals = S.state.approvals.filter((a) => a.approvalId !== m.approvalId);
      renderPending();
      break;
    case "userInput":
      if (!S.state) break;
      S.state.userInputs = S.state.userInputs.filter((u) => u.userInputId !== m.request.userInputId).concat(m.request);
      renderPending();
      break;
    case "userInputSettled":
      if (!S.state) break;
      S.state.userInputs = S.state.userInputs.filter((u) => u.userInputId !== m.userInputId);
      delete S.userInputDraft[m.userInputId];
      renderPending();
      break;
    case "changedFiles":
      if (S.state) S.state.changedFiles = m.files;
      renderChips();
      break;
    case "sessions":
      S.sessions = m.sessions;
      renderSessions();
      break;
    case "models":
      S.models = m.models;
      if (S.popup === "model") openPopup("model");
      break;
    case "editorContext":
      S.editorCtx = m.ctx;
      renderChips();
      break;
    case "insertText":
      insertAtCursor(m.text);
      break;
    case "restorePrompt":
      if (!input.value.trim()) {
        input.value = m.text;
        autosize();
      }
      break;
    case "focusInput":
      input.focus();
      break;
    case "blurInput":
      input.blur();
      break;
    case "toast":
      toast(m.level, m.message, m.action);
      break;
  }
});

autosize();
post({ type: "ready" });
input.focus();
