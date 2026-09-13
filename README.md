# Muse Code for VS Code (Unofficial)

> **Fork note (aminamos):** this fork tracks upstream plus fixes for Muse CLI 1.2.1 (server-request approval receipts), Windows `.cmd` shim resolution, and a registry-mirror-free `package-lock.json`. See the [changelog](CHANGELOG.md) and the PR upstream.

A native VS Code chat UI for [Muse Code](https://developer.meta.com/ai/lp/muse-code/), Meta's agentic terminal coding agent.

> **Unofficial community project.** This extension is not made, endorsed, or supported by Meta. "Muse" and "Muse Code" are Meta's names for their product; they are used here only to describe what the extension connects to.
>
> **Inspired by the Claude Code VS Code extension.** The layout, commands, keybindings, settings and workflow of this extension deliberately mirror Anthropic's [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) so that anyone who knows that extension feels at home. This project is not affiliated with Anthropic or Meta.

- **Works alongside you:** Muse explores your codebase, reads and writes code, and runs terminal commands with your approval.
- **Integrated with the editor:** Muse knows about your current file and text selection, and you can review its file changes as a diff right in the editor.
- **Durable sessions:** resume any past conversation for the workspace, including ones started from the `muse` terminal TUI.
- **Agentic features supported:** approvals with policy amendments, user-input questions, subagents, todo lists, context compaction, model and reasoning-effort selection, and user shell commands.

## Requirements

- VS Code 1.98.0 or higher.
- The `muse` CLI, version 1.0.3 or later. Run `muse login` once before using the extension. The extension looks for `muse` on `PATH`, in common install locations (`~/.local/bin`, `/opt/homebrew/bin`, ...), and via your login shell, so it works even when VS Code is launched from the Dock. Set `museCode.executablePath` only if it still cannot be found.

## Getting started

1. Open a folder.
2. Click the Muse icon in the editor title bar, or press `Cmd+Escape` (`Ctrl+Escape` on Windows/Linux).
3. Type a message and press Enter.

Use `@` to mention files, `/` for commands, and `!` to run a shell command yourself.

## Commands

| Command | Default keybinding |
| --- | --- |
| Muse Code: Open | `Cmd/Ctrl+Escape` (focus) |
| Muse Code: Open in New Tab | `Cmd/Ctrl+Shift+Escape` |
| Muse Code: Open in Side Bar | |
| Muse Code: Open in New Window | |
| Muse Code: Open in Terminal | `Cmd/Ctrl+Escape` when `museCode.useTerminal` is on |
| Muse Code: New Conversation | `Cmd/Ctrl+N` when enabled |
| Muse Code: Resume Past Conversation | |
| Muse Code: Reopen Closed Session | `Cmd/Ctrl+Shift+T` |
| Muse Code: Insert @-Mention Reference | `Alt+K` |
| Muse Code: Toggle Focus view | `Ctrl+Alt+F` |
| Muse Code: Create Worktree | |
| Muse Code: Accept / Reject Proposed Changes | editor title buttons while viewing a diff |
| Muse Code: Login / Logout | |
| Muse Code: Show Logs | |

Inside the chat: `Enter` sends, `Shift+Enter` inserts a newline, `Esc` interrupts, `Shift+Tab` cycles the approval mode, `↑` recalls previous prompts.

## Settings

| Setting | Description |
| --- | --- |
| `museCode.executablePath` | Path to the `muse` executable. A bare name (default `muse`) is resolved via `PATH`, common install dirs, and your login shell; `~` is expanded. |
| `museCode.environmentVariables` | Extra environment variables for the Muse process. |
| `museCode.useTerminal` | Run the `muse` TUI in a terminal instead of the native UI. |
| `museCode.initialApprovalMode` | `onRequest`, `promptUnmatched`, `denyUnmatched` or `allowAll` for new conversations. |
| `museCode.allowDangerouslyAllowAll` | Permit the `allowAll` mode (never asks). Sandboxes only. Picking "Allow all" in the mode picker offers to turn this on after a confirmation. |
| `museCode.autoApproveLowRisk` | Smart auto-approve for low-impact approvals (default off): read-only file access is approved automatically, once-only scope, never widened. Everything else still asks. Unknown subjects are never auto-approved. |
| `museCode.slashSkillScopes` | Which Muse skills show up as `/` commands: any of `project`, `user`, `plugin`, `bundled` (default: all but `bundled`). |
| `museCode.model` / `museCode.reasoningEffort` | Defaults for new conversations. |
| `museCode.autosave` | Save all files before each prompt. |
| `museCode.focusView` | Hide tool calls and reasoning; show only prompts and replies. |
| `museCode.useCtrlEnterToSend` | Send with Ctrl/Cmd+Enter so Enter inserts newlines. |
| `museCode.preferredLocation` | `panel` (editor tab) or `sidebar`. |
| `museCode.includeEditorContext` | Attach the active file and selection to prompts. |
| `museCode.respectGitIgnore` | Respect `.gitignore` in the @-mention file picker. |
| `museCode.hideOnboarding` | Hide the welcome checklist. |

## How it works

The extension launches `muse serve`, the Muse Session Protocol (MSP) host, once per workspace folder and talks to it over newline-delimited JSON-RPC on stdio. Sessions, turns, streaming items, approvals and user-input prompts are all MSP objects; the TypeScript types in `src/msp/msp.d.ts` are generated by `muse schema generate-ts` and can be regenerated for a newer CLI.

Approval modes map directly onto Muse's: **On request** (ask when a tool requests it), **Prompt unmatched** (ask for anything no policy already allows), **Deny unmatched**, and **Allow all**.

### Smart auto-approve (`museCode.autoApproveLowRisk`)

There is no risk-aware mode in Muse itself — the four modes above are all-or-nothing per policy match. This extension adds an optional client-side middle ground (off by default): when an approval arrives for **read-only file access** and the server offers an approve-once choice, the extension takes it immediately and shows a toast instead of a card. The rules are fail-closed:

- only `fileAccess` + `access: read` subjects; shell, network, process, writes, and unknown subject kinds always ask (per MSP SS5.2, unknown kinds are never auto-approved);
- only a server-offered `approved` + `once` choice is used — the scope is never widened to session/always;
- if the decide call fails, the normal approval card appears as fallback.

### Muse CLI 1.2.1 changes

This fork targets CLI 1.2.1 (regenerate with `muse schema generate-ts --out src/msp` after upgrading `muse`):

- **Server-initiated requests:** CLI 1.2.1 delivers approvals and user-input prompts as `approval/request` / `userInput/request` calls that must be answered with a presentation receipt (`{}`); the decision/answer still travels as `approval/decide` / `userInput/answer`. The extension answers the receipt and fans the request out like the notification channel, so older notification-only flows keep working too.
- **Windows:** a resolved `muse.cmd` launcher shim is mapped to its versioned `muse-bin-<ver>.exe` (via the sibling `.muse-version` file), because Node cannot spawn `.cmd` files without a shell.

## Prefer the terminal?

Set `museCode.useTerminal` to `true`. The Muse icon and `Cmd/Ctrl+Escape` then open the `muse` TUI in an integrated terminal, and `Cmd/Ctrl+Alt+K` types an `@file#L1-2` reference for the current selection into it.

## Development

```sh
npm install
npm run build        # or: npm run watch
# Press F5 in VS Code to launch the Extension Development Host
npm run package      # produces muse-code-<version>.vsix
```

Regenerate the protocol types after upgrading `muse`:

```sh
muse schema generate-ts --out src/msp
```

## Acknowledgements

Inspired by the Claude Code VS Code extension by Anthropic. Muse Code is a product of Meta. This is an independent community project released under the MIT license.
