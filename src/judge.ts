/**
 * DIY second-opinion risk screen for approvals (the "judge").
 *
 * Background: the CLI's built-in LLM approval judge (`--approval-judge`,
 * default on) has no control surface over MSP/`serve` — it is reporting-only
 * on the wire (`judgeEscalated`, `resolvedBy: "llmJudge"`). So this module is
 * a local, deterministic reviewer that sits in front of smart auto-approve.
 *
 * Safety contract (fail-closed, escalate-only):
 * - It can only VETO an auto-approval and force human review.
 * - It can NEVER approve anything itself; it returns a verdict, not a choice.
 * - Unknown/missing data is treated as risky when it bears on the decision.
 */
export interface JudgeInput {
  toolName?: unknown;
  rawArgs?: unknown;
  /** Kept as unknown so generated MSP types pass without casts; narrowed at runtime. */
  subject?: unknown;
  protectedWrite?: unknown;
  judgeEscalated?: unknown;
}

export interface JudgeVerdict {
  risky: boolean;
  reason: string | null;
}

/** Cap on rawArgs bytes scanned, so a huge tool payload can't stall the UI. */
const MAX_ARGS_SCAN = 8192;

const RISKY_TOOL = /(^|[^a-z])(sh|bash|zsh|fish|shell|exec|powershell|pwsh|cmd(\.exe)?|rm|del|mkfs|dd|format|shutdown|reboot|kill|taskkill|curl|wget)([^a-z]|$)/i;

const RISKY_ARG_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+-rf?\b/i, "destructive delete (`rm -r`) in tool args"],
  [/\b(mkfs|dd\s+[^ ]*\s+of=|:?\(\s*\)\s*\{)/i, "destructive shell construct in tool args"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|powershell|pwsh)\b/i, "pipe-to-shell download in tool args"],
  [/-(EncodedCommand|enc)\b/i, "obfuscated PowerShell (`-EncodedCommand`) in tool args"],
  [/\b(api_key|authorization|bearer|cookie|credential|password|passwd|secret|token)\b\s*[:=]/i, "possible credential in tool args"],
  [/\.\.(\/|\\|%2e)/, "path traversal (`..`) in tool args"],
  [/(\/etc\/(passwd|shadow|sudoers)|C:\\Windows\\(System32|Tasks)|~\/\.ssh\/)/i, "sensitive system path in tool args"],
];

function argsText(rawArgs: unknown): string {
  if (typeof rawArgs !== "string" || rawArgs.length === 0) return "";
  return rawArgs.length > MAX_ARGS_SCAN ? rawArgs.slice(0, MAX_ARGS_SCAN) : rawArgs;
}

/**
 * Review an approval request. Returns `{ risky: false }` only when every
 * available signal looks benign; anything suspicious returns a reason.
 * Pure and synchronous — safe to unit test.
 */
export function reviewApproval(a: JudgeInput): JudgeVerdict {
  if (a?.judgeEscalated === true) {
    return { risky: true, reason: "the server's approval judge escalated this request" };
  }
  if (a?.protectedWrite === true) {
    return { risky: true, reason: "this request is a protected write" };
  }
  const subject = typeof a?.subject === "object" && a.subject !== null ? (a.subject as Record<string, unknown>) : null;
  if (!subject || subject.kind !== "fileAccess") {
    return { risky: true, reason: "non-file or unknown subject kind" };
  }
  if (subject.access !== "read") {
    return { risky: true, reason: `non-read file access (${String(subject.access)})` };
  }
  if (typeof a?.toolName === "string" && RISKY_TOOL.test(a.toolName)) {
    return { risky: true, reason: `risky tool name (${a.toolName})` };
  }
  const args = argsText(a?.rawArgs);
  for (const [re, reason] of RISKY_ARG_PATTERNS) {
    if (re.test(args)) return { risky: true, reason };
  }
  return { risky: false, reason: null };
}
