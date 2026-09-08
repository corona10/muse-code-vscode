# Changelog

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
