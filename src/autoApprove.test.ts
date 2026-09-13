import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autoApproveChoice, resolutionNote } from "./autoApprove.ts";

function approval(subject: Record<string, unknown>, choices: Array<Record<string, unknown>>) {
  return { subject, availableChoices: choices } as Parameters<typeof autoApproveChoice>[0];
}

const ONCE = { choiceId: "allow_once", decision: "approved", scope: "once", label: "Allow once" };
const SESSION = { choiceId: "allow_session", decision: "approvedForSession", scope: "session", label: "Allow session" };
const DENY = { choiceId: "deny", decision: "denied", scope: "once", label: "Deny" };

describe("autoApproveChoice", () => {
  it("auto-approves a read-only file access with an approve-once choice", () => {
    const d = autoApproveChoice(approval({ kind: "fileAccess", access: "read", path: "/tmp/x" }, [ONCE, DENY]));
    assert.equal(d?.choiceId, "allow_once");
  });

  it("refuses file writes", () => {
    assert.equal(autoApproveChoice(approval({ kind: "fileAccess", access: "write", path: "/tmp/x" }, [ONCE])), null);
  });

  it("refuses shell, network, process and tool subjects", () => {
    for (const kind of ["shell", "network", "process", "tool"]) {
      assert.equal(autoApproveChoice(approval({ kind, command: "x" }, [ONCE])), null, kind);
    }
  });

  it("never auto-approves unknown subject kinds (SS5.2)", () => {
    assert.equal(autoApproveChoice(approval({ kind: "quantumTeleport" }, [ONCE])), null);
  });

  it("fails closed on missing subject or access", () => {
    assert.equal(autoApproveChoice(approval({ kind: "fileAccess" }, [ONCE])), null);
    assert.equal(autoApproveChoice(approval({}, [ONCE])), null);
  });

  it("never widens scope: session/always-only or deny-only choices are left alone", () => {
    assert.equal(autoApproveChoice(approval({ kind: "fileAccess", access: "read" }, [SESSION])), null);
    assert.equal(autoApproveChoice(approval({ kind: "fileAccess", access: "read" }, [DENY])), null);
    assert.equal(autoApproveChoice(approval({ kind: "fileAccess", access: "read" }, [])), null);
  });
});

describe("resolutionNote", () => {
  it("notes LLM judge approvals and denials", () => {
    assert.equal(resolutionNote({ resolvedBy: "llmJudge", decision: "approved" }), "The LLM approval judge approved this request.");
    assert.equal(resolutionNote({ resolvedBy: "llmJudge", decision: "approvedForSession" }), "The LLM approval judge approved this request.");
    assert.equal(resolutionNote({ resolvedBy: "llmJudge", decision: "denied" }), "The LLM approval judge denied this request.");
    assert.equal(resolutionNote({ resolvedBy: "llmJudge", decision: "timedOut" }), "The LLM approval judge resolved this request.");
  });

  it("stays silent for user, policy, and unknown resolvers", () => {
    assert.equal(resolutionNote({ resolvedBy: "user", decision: "approved" }), null);
    assert.equal(resolutionNote({ resolvedBy: "policy", decision: "approved" }), null);
    assert.equal(resolutionNote({ resolvedBy: "mystery", decision: "approved" }), null);
    assert.equal(resolutionNote({}), null);
  });
});
