# Worklog TUI

This document describes the interactive terminal UI shipped as the `wl tui` (or `worklog tui`) command.

## Overview

- The TUI presents a tree view of work items on the left and a details pane on the right.
- It can show all items, or be limited to in-progress items via `--in-progress`.
- The details pane uses the same human formatter as the CLI so what you see in the TUI matches `wl show --format full`.
- Integrated OpenCode AI assistant for intelligent work item management and coding assistance.

## Controls

### Navigation

- Arrow Up / Down — move selection
- Right / Enter — expand node
- Left — collapse node (or collapse parent)
- Space — toggle expand/collapse
- Mouse — click to select and scroll
- q / Esc / Ctrl-C — quit
- Ctrl+W, Ctrl+W — cycle focus between list, details, and OpenCode
- Ctrl+W, h / l — focus list or details
- Ctrl+W, k / j — move focus between OpenCode response and input
- Ctrl+W, p — focus previous pane

### Work Item Actions

- n — create new work item
- e — edit selected item
- c — add comment to selected item
- d — delete selected item
- r — refresh/reload items
- / — search items
- v — cycle needs-producer-review filter (on/off/all)
- h — toggle help menu
- D — toggle do-not-delegate tag on selected item
- **g — delegate selected item to GitHub Copilot** (opens confirmation modal with optional Force override; see `wl github delegate` for CLI equivalent)
- **m — move/reparent item** (see below)

### Move / Reparent Mode

Press **m** on a selected item to enter move mode. The source item is marked with a yellow `[M]` prefix and its descendants are dimmed (they cannot be chosen as targets). The footer shows move mode instructions.

While in move mode:

- **Navigate** with the usual up/down/left/right keys to reach the desired target parent.
- **m or Enter** on the target item — reparent the source under the target. The target's tree node is automatically expanded so you can see the moved item.
- **m or Enter on the source item itself** — unparent the item (move it to root level). If it is already a root item, a toast message informs you and move mode exits.
- **Esc** — cancel move mode without making changes.

Other action keys (close, update, search, filters, etc.) are suppressed during move mode to prevent accidental edits.

### OpenCode AI Integration

- **O** (capital O) — open OpenCode AI assistant dialog
  - Ctrl+S — send prompt
  - Enter — accept autocomplete or add newline
  - Escape — close dialog
  - Prefix `!` to run a local shell command in the project root
  - Ctrl+C cancels a running `!` command without closing the prompt
  - Command shows in orange; output streams in white
- When OpenCode is active:
  - Response appears in bottom pane
  - Input fields appear when agent needs information
  - q or click [x] to close response pane

## OpenCode Features

### Auto-start Server

The OpenCode server automatically starts when you press O. Server status indicators:

- `[-]` — Server stopped
- `[~]` — Server starting
- `[OK] Port: 9999` — Server running (example; configurable via `OPENCODE_SERVER_PORT` or auto-selected)
- `[X]` — Server error

### Slash Commands

Type `/` in the OpenCode dialog to see available commands:

- `/help` — Get help with OpenCode
- `/edit` — Edit files with AI assistance
- `/create` — Create a new Worklog work item
- `/test` — Generate or run tests
- `/fix` — Fix issues in code
- Plus 20+ more commands

### `/create` — Create Work Items from the TUI

The `/create` command lets you create Worklog work items directly from the OpenCode prompt without leaving the TUI.

**Usage:**

```
/create <short title or description of the work item>
```

The command automatically:

- Generates a concise title (up to 72 characters) from your input.
- Builds a detailed description containing the full verbatim text, creation metadata, and an "Open Questions" section if the input is ambiguous.
- Chooses an appropriate issue-type and priority based on the description:
  - Text mentioning bugs, errors, or failing tests defaults to `bug` / `high`.
  - Text describing user-visible changes defaults to `feature` / `medium`.
  - All other text defaults to `task` / `medium`.
- Runs `wl create` and displays the resulting work-item JSON in the response pane.

The new item is created at root level by default. To make it a child of a specific work item, say so explicitly (e.g., `/create child of WL-1234: add input validation`).

**Examples:**

```
/create Fix login page redirect when session expires
/create Investigate intermittent database connection errors seen in staging
/create child of WL-1234: add unit tests for the auth module
```

**Security notes:**

- The command only invokes `wl create`. It does not run arbitrary shell commands, modify repository files, or mutate existing work items.
- All user input is passed via heredoc-style escaping to prevent shell injection.
- Changes to permission scope (e.g., allowing edits to existing items) require Producer approval.

For the full command specification, see `.opencode/command/create.md`. For the parent feature context, see Add /create OpenCode command for creating work items from TUI (WL-0MLSDIRLA0BXRCDB).

### Interactive Sessions

- Sessions persist across multiple prompts
- Real-time streaming responses
- Interactive input when agents need clarification
- Tool usage highlighted in colors

For detailed OpenCode documentation, see `docs/opencode-tui.md`.

## Usage

Install dependencies and run from source:

```
npm install
npm run cli -- tui
```

## Options

- `--in-progress` — show only items with status `in-progress`.
- `--all` — include completed and deleted items in the list.
- `--prefix <prefix>` — use a different project prefix.

## Notes

- The TUI uses `blessed` for rendering. For a smoother TypeScript developer experience install the types: `npm install -D @types/blessed`.
- The TUI is intentionally lightweight: it renders items from the current database snapshot. If you want live updates across processes, run a background sync or re-open the TUI.
