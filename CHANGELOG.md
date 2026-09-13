# Changelog

## 0.6.0 (aminamos fork)

- DIY second-opinion judge: new `museCode.judgeReview` setting (default on) that screens proposed smart auto-approvals (`src/judge.ts`, covered by `src/judge.test.ts`). It checks `judgeEscalated`, `protectedWrite`, subject kind/access, tool name, and raw args (destructive commands, pipe-to-shell, `-EncodedCommand`, possible credentials, `..` traversal, sensitive system paths). A hit vetoes the auto-approval and shows the card plus a warning toast with the reason. Escalate-only by design: it can never approve anything itself, and `judgeReview: false` restores raw auto-approve.

## 0.5.3 (aminamos fork)

- Judge visibility: approvals resolved by the CLI's LLM approval judge now raise an info toast ("The LLM approval judge approved/denied this request"). There is deliberately no on/off toggle — 1.2.1 exposes no control surface for the judge (no MSP param, no `serve` flag, no session param; the judge runs per host configuration, default on). Covered by `resolutionNote` cases in `src/autoApprove.test.ts`.

## 0.5.2 (aminamos fork)

- Smart auto-approve for low-impact approvals: new `museCode.autoApproveLowRisk` setting (default off). Read-only file access with a server-offered approve-once choice is decided immediately with a toast instead of a card. Fail-closed: shell/network/process/writes and unknown subject kinds always ask, scope is never widened, and a failed decide falls back to the card. Covered by `src/autoApprove.test.ts` (`npm test`).

## 0.5.1 (aminamos fork)

- Windows: resolve a `muse.cmd` launcher shim to its versioned `muse-bin-<ver>.exe` via the sibling `.muse-version` file. Node cannot spawn `.cmd` without a shell (`spawn EINVAL`), which previously broke both `muse serve` startup and the skills list on Windows.
- CLI 1.2.1 protocol: answer server-initiated `approval/request` / `userInput/request` with a presentation receipt and fan them out as `approval/requested` / `userInput/requested`. Without this, approval cards rendered but every decision was rejected (`approvalChoiceInvalid` / `approvalRequirementStale`) and turns could not start. `msp.d.ts` regenerated from CLI 1.2.1.
- `package-lock.json` rewritten from the dead `npm-registry-proxy.kr.wekarrot.net` mirror to `registry.npmjs.org` so `npm install` works outside the mirror's network.

## 0.5.0

- Muse skills appear as slash commands: project skills in `.agents/skills/<name>/SKILL.md` plus user and plugin skills (bundled ones via `museCode.slashSkillScopes`). Each skill is `/skill:<name>`; running `/skill:<name> args` sends `/<name> args` as the prompt so Muse loads the skill, and Tab completes the name to keep typing arguments. `/skills` refreshes the list; edits under `.agents/skills` refresh it automatically.

## 0.4.0

- "Allow all" can be enabled from the approval-mode picker: choosing it shows a confirmation dialog that turns on `museCode.allowDangerouslyAllowAll` instead of requiring a manual settings edit.

## 0.3.0

- Slash command menu: Up/Down arrows move the selection; Enter/Tab runs the highlighted command.

## 0.2.0

- Resolve a bare `muse` executable name via `PATH`, common install locations, and the login shell, so the extension starts when VS Code is launched from the Dock without a shell `PATH`. `~` in `museCode.executablePath` is expanded.

## 0.1.0

- Initial release: native chat UI over `muse serve` (MSP v1), side bar and editor-tab locations, approvals, user-input questions, past conversations, @-mentions, editor context, proposed-change diffs, focus view, terminal mode, walkthrough.
