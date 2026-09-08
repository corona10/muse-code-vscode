import type {
  ApprovalMode,
  ApprovalRequestParams,
  ContextUsage,
  CumulativeTokenUsage,
  Item,
  ModelCatalogEntry,
  ReasoningEffort,
  TodoItem,
  TurnError,
  TurnInputPart,
  UserInputAnswer,
  UserInputRequestParams,
} from "./msp/msp";

/** Messages exchanged between the extension host and the chat webview. */

export type HostStatus = "starting" | "ready" | "stopped" | "failed";

export interface UiConfig {
  focusView: boolean;
  useCtrlEnterToSend: boolean;
  hideOnboarding: boolean;
  includeEditorContext: boolean;
  allowAllEnabled: boolean;
  userShell: boolean;
  location: "panel" | "sidebar";
}

export interface QueuedTurn {
  turnId: string;
  text: string;
}

export interface UiMeta {
  running: boolean;
  activeTurnId: string | null;
  queuedTurns: QueuedTurn[];
  approvalMode: ApprovalMode | null;
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  contextUsage: ContextUsage | null;
  tokenUsage: CumulativeTokenUsage | null;
  todo: TodoItem[];
  branch: string | null;
  title: string | null;
  hostStatus: HostStatus;
  hostMessage: string | null;
  lastError: TurnError | null;
}

export interface UiState {
  sessionId: string | null;
  workspaceRoot: string;
  items: Item[];
  meta: UiMeta;
  approvals: ApprovalRequestParams[];
  userInputs: UserInputRequestParams[];
  changedFiles: string[];
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  turnCount: number;
  modelId: string | null;
  status: string;
}

export interface EditorContext {
  path: string; // workspace-relative when possible
  absolutePath: string;
  languageId: string;
  selection: { startLine: number; endLine: number; text: string } | null;
}

/** A skill the `muse` CLI can load, surfaced as a slash command in the composer. */
export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  /** `project`, `user`, `plugin` or `bundled`. */
  scope: string;
  path: string;
}

export type ToWebview =
  | { type: "init"; config: UiConfig; state: UiState }
  | { type: "state"; state: UiState }
  | { type: "item"; item: Item }
  | { type: "delta"; itemId: string; field: string; delta: string }
  | { type: "meta"; meta: Partial<UiMeta> }
  | { type: "approval"; approval: ApprovalRequestParams }
  | { type: "approvalResolved"; approvalId: string }
  | { type: "userInput"; request: UserInputRequestParams }
  | { type: "userInputSettled"; userInputId: string }
  | { type: "changedFiles"; files: string[] }
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "models"; models: ModelCatalogEntry[] }
  | { type: "skills"; skills: SkillEntry[] }
  | { type: "config"; config: UiConfig }
  | { type: "editorContext"; ctx: EditorContext | null }
  | { type: "insertText"; text: string }
  | { type: "restorePrompt"; text: string }
  | { type: "focusInput" }
  | { type: "blurInput" }
  | { type: "toast"; level: "info" | "warning" | "error"; message: string; action?: { label: string; command: string } };

export interface SendPayload {
  text: string;
  images: { mediaType: string; base64Data: string }[];
  includeEditorContext: boolean;
  ifBusy?: "queue" | "steer" | "replace";
}

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; payload: SendPayload }
  | { type: "interrupt" }
  | { type: "unqueue"; turnId: string }
  | { type: "decideApproval"; approvalId: string; choiceId: string; requirementId: { approvalId: string; sourceIndex: number }; feedback?: string }
  | { type: "answerUserInput"; userInputId: string; answers: UserInputAnswer[] }
  | { type: "cancelUserInput"; userInputId: string }
  | { type: "newConversation" }
  | { type: "listSessions" }
  | { type: "resumeSession"; sessionId: string }
  | { type: "listModels" }
  | { type: "listSkills" }
  | { type: "setModel"; modelId: string }
  | { type: "setApprovalMode"; mode: ApprovalMode }
  | { type: "setReasoningEffort"; effort: ReasoningEffort | null }
  | { type: "compact" }
  | { type: "runShell"; command: string }
  | { type: "openFile"; path: string; line?: number }
  | { type: "openDiff"; path: string }
  | { type: "pickFile" }
  | { type: "toggleFocusView" }
  | { type: "setConfig"; key: "useCtrlEnterToSend" | "hideOnboarding" | "includeEditorContext"; value: boolean }
  | { type: "command"; command: string }
  | { type: "openExternal"; url: string }
  | { type: "copy"; text: string }
  | { type: "log"; message: string };

export function turnInputFromPayload(text: string, images: SendPayload["images"]): TurnInputPart[] {
  const parts: TurnInputPart[] = [];
  if (text.trim().length > 0) parts.push({ type: "text", text });
  for (const img of images) parts.push({ type: "image", mediaType: img.mediaType, base64Data: img.base64Data });
  return parts;
}
