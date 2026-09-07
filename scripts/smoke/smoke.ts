import { MuseHost } from "../../src/msp/host";
import { Conversation } from "../../src/conversation";
const root = process.cwd();
const host = new MuseHost({ workspaceRoot: root, executable: "muse", env: {}, trustWorkspace: true, version: "smoke", log: (l) => console.log("  [log]", l) });
const conv = new Conversation(host, root, { approvalMode: "onRequest" });
const seen: string[] = [];
conv.on("message", (m: any) => {
  if (m.type === "delta") { seen.push("delta"); return; }
  seen.push(m.type);
  const brief = m.type === "item" ? `${m.item.kind}/${m.item.status}${m.item.tool ? " " + m.item.tool : ""}` : m.type === "meta" ? JSON.stringify(m.meta).slice(0, 120) : m.type === "approval" ? `${m.approval.subject.kind} ${m.approval.subject.command ?? m.approval.subject.path ?? ""} choices=${m.approval.availableChoices.map((c: any) => c.label).join("|")}` : m.type === "toast" ? m.message : "";
  console.log("  <-", m.type, brief);
  if (m.type === "approval") {
    const a = m.approval; const c = a.availableChoices.find((c: any) => c.decision === "approved") ?? a.availableChoices[0];
    conv.decideApproval(a.approvalId, c.choiceId, a.currentRequirementId).then((r) => console.log("  approval/decide ->", JSON.stringify(r)));
  }
});
(async () => {
  await conv.startNew();
  console.log("session:", conv.sessionId, "mode:", conv.state.meta.approvalMode, "userShell:", host.userShellGranted);
  const models = await conv.listModels();
  console.log("models:", models.map((m) => m.modelId).join(", "));
  await conv.sendTurn([{ type: "text", text: "Create a file named smoke_test.txt in the workspace containing the single word hello, then reply with 'done'." }], "smoke prompt");
  await new Promise<void>((res) => { conv.on("turnCompleted", () => res()); setTimeout(res, 120000); });
  console.log("items:", conv.state.items.map((i) => `${i.kind}:${i.status}`).join(" "));
  console.log("changedFiles:", conv.state.changedFiles, "title:", conv.state.meta.title, "ctx:", JSON.stringify(conv.state.meta.contextUsage));
  const sessions = await conv.listSessions(5);
  console.log("sessions:", sessions.map((s) => `${s.sessionId.slice(0, 8)} "${s.title}" turns=${s.turnCount}`).join("; "));
  // resume the same session on the same host, then on a fresh host
  const conv2 = new Conversation(host, root);
  await conv2.resume(conv.sessionId!);
  console.log("resume(same host) items:", conv2.state.items.length, "running:", conv2.state.meta.running);
  conv2.dispose(); conv.dispose(); host.dispose();
  const host2 = new MuseHost({ workspaceRoot: root, executable: "muse", env: {}, trustWorkspace: true, version: "smoke", log: () => {} });
  const conv3 = new Conversation(host2, root);
  await conv3.resume(sessions[0].sessionId);
  console.log("resume(fresh host) items:", conv3.state.items.length, "approvals:", conv3.state.approvals.length, "mode:", conv3.state.meta.approvalMode);
  host2.dispose();
  console.log("message types seen:", [...new Set(seen)].join(","));
})().catch((e) => { console.error("SMOKE FAILED:", e); process.exit(1); });
