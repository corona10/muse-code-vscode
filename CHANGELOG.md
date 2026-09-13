# Changelog

## 0.7.0

- Security: Markdown links in replies are tokenized before the other inline passes run, so text in a model reply can no longer add attributes to a generated link; the webview CSP no longer allows `img-src https:`. Regression check: `npm run test:markdown`.
- Muse CLI 1.2.1: approvals and user-input prompts that arrive as server-initiated requests are acknowledged and handled; types regenerated from the 1.2.1 schema.
- Windows: a `muse.cmd` launcher shim resolves to its versioned `muse-bin-<ver>.exe`, so `muse serve` and the skills list start.
- Optional smart auto-approve for read-only file access (`museCode.autoApproveLowRisk`, off by default) with a local review that can only veto (`museCode.judgeReview`); toasts when the CLI's approval judge resolves a request. Unit tests: `npm test`.
- `package-lock.json` resolves from `registry.npmjs.org`, so `npm install` works from a fresh clone.
- Source maps are no longer shipped in the `.vsix`.

## 0.6.0

- File edits show as inline diffs in the chat: each `edit_file` / `write_file` call renders its added and removed lines with a +/− count and a link to the file, using the diff Muse's edit tools report (or a line diff of the find/replace arguments when they don't). Expanding the call still shows the raw arguments. Turn off with `museCode.showInlineDiffs`.
- Sending a message while Muse is working now steers it into the running turn instead of queueing it, matching the Claude Code extension. Set `museCode.sendWhileRunning` to `queue` for the old behaviour. The composer placeholder says which will happen.
- Approval mode picker: the "Allow all" description now says that Muse still asks for shell commands it cannot parse statically (verified against `muse serve`).

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
