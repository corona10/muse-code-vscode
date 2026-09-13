export interface AutoApproveDecision {
  choiceId: string;
  reason: string;
}

/** Minimal structural view of an approval: deliberately decoupled from the generated MSP types. */
export interface ApprovalLike {
  subject?: { kind?: unknown; access?: unknown; path?: unknown; target?: unknown } | null;
  availableChoices?: Array<{ choiceId?: unknown; decision?: unknown; scope?: unknown }> | null;
}

/**
 * Smart auto-approve for low-impact approvals.
 *
 * Fail-closed by design: only a `fileAccess` subject with `access === "read"`
 * is ever approved, and only via a server-offered choice with
 * `decision === "approved"` and `scope === "once"` — the approval is never
 * widened to session/always, and unknown subject kinds are never
 * auto-approved (MSP SS5.2). Everything else returns null (show the card).
 */
export function autoApproveChoice(a: ApprovalLike): AutoApproveDecision | null {
  const subject = a?.subject;
  if (!subject || subject.kind !== "fileAccess") return null;
  if (subject.access !== "read") return null;
  const choices = Array.isArray(a.availableChoices) ? a.availableChoices : [];
  const once = choices.find((c) => c?.decision === "approved" && c?.scope === "once" && typeof c?.choiceId === "string");
  if (!once || typeof once.choiceId !== "string") return null;
  const what = typeof subject.path === "string" ? subject.path : typeof subject.target === "string" ? subject.target : "file";
  return { choiceId: once.choiceId, reason: `auto-approved read of ${what}` };
}
