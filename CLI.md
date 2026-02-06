# Worklog CLI Reference (wl / worklog / wf)

This document describes the Worklog CLI commands and includes examples. Plugin commands can be added at runtime; to see any plugins available in your environment run `wl --help` (or `worklog --help` or `wf --help`). The layout follows the grouped output produced by `wl --help` so entries match the CLI ordering.

## Global options

These options apply to any command:

- `-V, --version` — Print the CLI version.
- `--json` — Produce machine-readable JSON output instead of human text.
- `--verbose` — Enable verbose output (extra timing / debug info where supported).
- `-F, --format <format>` — Choose human display format for work items: `concise`, `normal`, `full`, `raw`.


These flags control overall CLI behavior: output format (JSON vs human), verbosity for debugging, and the display format for human-readable commands. Use `--json` for automation and `--format` when you need more or less detail in terminal output.


---

## Issue Management

Issue Management commands let you create, update, delete, comment on, and close work items. Use these for day-to-day work item lifecycle tasks: creating new tasks or bugs, recording progress, adding notes, and closing completed work.

### `create` [options]

Create a new work item.

Options:

- `-t, --title <title>` (required) — Title of the work item.
- `-d, --description <description>` — Description text (optional; defaults to empty).
- `-s, --status <status>` — One of `open`, `in-progress`, `completed`, `blocked`, `deleted` (optional; default: `open`).
- `-p, --priority <priority>` — `low|medium|high|critical` (optional; default: `medium`).
- `-P, --parent <parentId>` — Parent work item ID (optional).
- `--tags <tags>` — Comma-separated tags (optional).
- `-a, --assignee <assignee>` — Assignee name (optional).
- `--stage <stage>` — Stage of the work item in the workflow (optional).
- `--risk <risk>` — Risk level: `Low|Medium|High|Severe` (optional; no default).
- `--effort <effort>` — Effort level: `XS|S|M|L|XL` (optional; no default).
- `--issue-type <issueType>` — Interoperability: issue type (optional).
- `--created-by <createdBy>` — Interoperability: created by (optional).
- `--deleted-by <deletedBy>` — Interoperability: deleted by (optional).
- `--delete-reason <deleteReason>` — Interoperability: delete reason (optional).
- `--prefix <prefix>` — Override default ID prefix (repo-local scope) (optional).
- `--json` — Output JSON (optional).

Examples:

```sh
wl create -t "Fix login bug"
wl create -t "Add telemetry" -d "Add event for signup" -p high -a alice --tags telemetry,signup
wl create -t "High-risk task" --risk High --effort M
wl --json create -t "Investigate CI flakes" -d "Flaky tests seen" -p high
```

### `update` [options] <id>

Update fields on an existing work item. Options mirror `create` for updatable fields.

Example:

```sh
wl update WL-ABC123 -t "New title" -p low
wl update WL-ABC123 -s in-progress -a "bob"
wl update WL-ABC123 --risk High --effort XS
```

### `delete` [options] <id>

Delete a work item (hard delete): this removes the work item row from the local database. Any comments attached to the work item are cascade-deleted by the database. If you prefer to mark an item as deleted without removing it, use `wl update <id> -s deleted` to set the `deleted` status.

Options:

- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl delete WL-ABC123            # permanently removes the item and its comments
wl --json delete WL-ABC123     # machine-readable confirmation (204 on success)
```

### `comment` (subcommands)

Manage comments attached to work items. Use `wl comment <subcommand>`.

Subcommands:

- `create <workItemId>` — Create a comment. Required: `-a, --author`, `-c, --comment`.
- `list <workItemId>` — List comments for a work item.
- `show <commentId>` — Show a single comment.
- `update <commentId>` — Update a comment's fields.
- `delete <commentId>` — Delete a comment.

Examples:

```sh
wl comment create WL-ABC123 -a alice -c "I narrowed this down to the auth layer."
wl comment list WL-ABC123
wl comment show CMT-0001
wl comment update CMT-0001 -c "Updated content"
wl comment delete CMT-0001
```

### `close` [options] <ids...>

Close one or more work items and optionally record a close reason as a comment.

Options:

`-r, --reason <reason>` — Reason text stored as a comment (optional).
`-a, --author <author>` — Author for the close comment (optional; default: `worklog`).
`--prefix <prefix>` — Operate within a specific prefix (optional).

Examples:

```sh
wl close WL-ABC123 -r "Resolved by PR #42" -a alice
wl close WL-ABC123 WL-DEF456 -r "Cleanup after release"
```

### `dep` (subcommands)

Manage dependency edges attached to work items. Use `wl dep <subcommand>`.

Notes:

- Prefer dependency edges for new work; they are the recommended way to track blockers.

Subcommands:

- `add <itemId> <dependsOnId>` — Create a dependency where `itemId` depends on `dependsOnId`.
- `rm <itemId> <dependsOnId>` — Remove a dependency where `itemId` depends on `dependsOnId`.
- `list <itemId>` — Show inbound and outbound dependencies for `itemId`.

Behavior:

- `dep add` errors if either work item does not exist.
- `dep add` errors if the dependency already exists.
- `dep rm` warns and exits 0 when ids are missing.
- `dep list` warns and exits 0 when ids are missing.
- `dep list --outgoing` shows only outbound dependencies.
- `dep list --incoming` shows only inbound dependencies.

Examples:

```sh
wl dep add WL-ABC123 WL-DEF456
wl dep rm WL-ABC123 WL-DEF456
wl dep list WL-ABC123
wl --json dep add WL-ABC123 WL-DEF456
```

---

## Status

Status commands help you inspect and discover work: listing items, viewing details, finding the next thing to work on, and seeing recent or in-progress items. Use these when triaging, planning a day, or preparing handoffs.

### `show` [options] <id>

Show details for a single work item.

Options:

`-c, --children` — Also display descendants in a tree layout (optional).
`--prefix <prefix>` (optional)

Examples:

```sh
wl show WL-ABC123
wl --json show WL-ABC123
wl show WL-ABC123 -c
```

### `next` [options]

Suggest the next work item(s) to work on using priority/status heuristics.

Options:

`-a, --assignee <assignee>` (optional)
`-s, --search <term>` (optional)
`-n, --number <n>` — Number of items to return (optional; default: `1`).
`--include-in-review` — Include items with stage `in_review` (optional).
`--prefix <prefix>` (optional)

Examples:

```sh
wl next
wl next -n 3
wl next -a alice --search "bug"
```

### `in-progress` [options]

List all in-progress work items in a dependency tree.

Example:

```sh
wl in-progress
```

### `recent` [options]

Show most recently changed work items.

Example:

```sh
wl recent
```

### `list` [options] [search]

List work items, optionally filtered and/or full-text searched.

Options:

`-s, --status <status>` (optional)
`-p, --priority <priority>` (optional)

`--tags <tags>` (optional)
`-a, --assignee <assignee>` (optional)
`-n, --number <n>` (optional) — Limit the number of items returned
`--stage <stage>` (optional)
`--prefix <prefix>` (optional)
`--json` (optional)

Examples:

```sh
wl list
wl list -s open -p high
wl list "signup"
wl -F concise list -s in-progress
wl --json list -s open --tags backlog
```

---

## Team

Team commands support sharing and synchronization of the canonical worklog with teammates and external systems. Use these to sync with the repository's canonical JSONL ref, and mirror data to/from GitHub Issues. Export and import commands are listed after sync and GitHub commands.

### `sync` [options]

Sync local worklog data with the canonical JSONL ref in git (pull, merge, push).

Important options:

- `-f, --file <filepath>` — Data file path (optional; default: configured data path, commonly `.worklog/worklog-data.jsonl`).
- `--git-remote <remote>` — Git remote to use (optional; default: `origin` or value from configuration).
- `--git-branch <ref>` — Git ref to store worklog data (optional; default: `refs/worklog/data` or value from configuration).
- `--no-push` — Skip pushing changes (optional).
- `--dry-run` — Preview changes without modifying local state or git (optional).
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl sync --dry-run
wl sync --git-remote origin --git-branch refs/worklog/data
```

Diagnostics:

```sh
wl sync debug
wl --json sync debug
```

Example (JSON / dry-run):

```sh
wl --json sync --dry-run
```

### `github` | `gh` (subcommands)

Mirror work items and comments with GitHub Issues.

Subcommands:

- `push` — Mirror work items to GitHub Issues. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--prefix <prefix>`.
- `import` — Import updates from GitHub Issues. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--since <ISO timestamp>`, `--create-new`, `--prefix <prefix>`.

Examples:

```sh
wl github push --repo myorg/myrepo
wl gh import --repo myorg/myrepo --since 2025-12-01T00:00:00Z --create-new
```

Example (JSON / label prefix):

```sh
wl --json github push --repo myorg/myrepo --label-prefix wl:
wl --json gh import --repo myorg/myrepo --since 2025-12-01T00:00:00Z --create-new
```

Notes on defaults and behavior:

- `--repo <owner/name>` — Optional; if omitted the command will attempt to read the repo from config or infer it from the git remote.
- `--label-prefix <prefix>` — Optional; default label prefix is `wl:`.
- `--since <ISO timestamp>` — Optional; when provided `import` only considers issues updated since that timestamp.
- `--create-new` (import only) — Optional flag; when set the importer will create new work items for unmarked GitHub issues. Default behavior: enabled unless `githubImportCreateNew` is explicitly set to `false` in configuration.

### `export` [options]

Export work items and comments to a JSONL file.

Example:

```sh
wl export -f .worklog/worklog-data.jsonl
```

Options:

- `-f, --file <filepath>` — Output file path (optional; default: repository data path, usually `.worklog/worklog-data.jsonl`).
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Example (JSON):

```sh
wl --json export -f .worklog/worklog-data.jsonl
```

### `import` [options]

Import work items and comments from a JSONL file.

Example:

```sh
wl import -f .worklog/worklog-data.jsonl
```

Options:

- `-f, --file <filepath>` — Input file path (optional; default: repository data path).
- `--prefix <prefix>` — Operate on a specific prefix (optional).

Example (import and verify):

```sh
wl import -f .worklog/worklog-data.jsonl
wl --json list | jq .workItems | head -n 20
```

---

## Maintenance

Maintenance commands are used for one-off migrations and data evolution tasks.

### `migrate` (subcommands)

Run data migrations.

Subcommands:

- `sort-index` — compute `sort_index` values using existing next-item ordering.

Options:

- `--dry-run` — Print the updates without applying them.
- `--gap <gap>` — Integer gap between consecutive `sort_index` values (optional; default: `100`).
- `--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl migrate sort-index --dry-run
wl migrate sort-index --gap 100
```

## Plugins

Plugin commands let you inspect installed extensions that add or alter CLI functionality. To list commands provided by plugins in your environment run `wl --help` (or `worklog --help`).

### `plugins`

List discovered plugins and their load status.

Example:

```sh
wl plugins
```

Worklog comes bundled with an example stats plugin installed.

- `stats` — Show custom work item statistics (example plugin provided in this repo).

---

## Other

Other commands cover repository bootstrap and local system status. Use these to initialize Worklog in a repo, check system health, or get help on a command.

### `init`

Initialize Worklog configuration in the repository (creates `.worklog` and default config). `wl init` also installs `AGENTS.md` in the project root from `templates/AGENTS.md`. If `AGENTS.md` already exists, it checks for the template content and prompts before appending it.

Options:

- `--project-name <name>` — Project name (optional).
- `--prefix <prefix>` — Issue ID prefix (optional).
- `--auto-export <yes|no>` — Auto-export data to JSONL after changes (optional).
- `--auto-sync <yes|no>` — Auto-sync data to git after changes (optional).
- `--agents-template <overwrite|append|skip>` — What to do when AGENTS.md exists (optional).
- `--workflow-inline <yes|no>` — Inline workflow into AGENTS.md when prompted (optional).
- `--stats-plugin-overwrite <yes|no>` — Overwrite existing stats plugin if present (optional).

Example:

```sh
wl init
wl init --project-name "My Project" --prefix PROJ --auto-export yes --auto-sync no
```

### `tui` [options]

Launch the terminal UI for browsing and filtering work items.

Options:

- `--in-progress` — Show only in-progress items.
- `--all` — Include completed/deleted items in the list.
- `--prefix <prefix>` — Override the default prefix.

Example:

```sh
wl tui --in-progress
```

Example (JSON):

```sh
wl --json init
```

### `status` [options]

Show Worklog system and database status (counts, configuration values).

Options:

- `--prefix <prefix>`
- `--json`

Example:

```sh
wl status
```

Example (JSON):

```sh
wl --json status
```

### `help` [command]

Show help for a specific command.

Example:

```sh
wl help create
```

---

## Examples and scripting tips

- Use JSON mode (`--json`) when scripting or integrating with other tools; parse the output with `jq`:

```sh
wl --json list -s open | jq .workItems
```

- Use `--format` to change human output verbosity:

```sh
wl -F concise show WL-ABC123    # compact summary
wl -F full show WL-ABC123       # full detail
```

- When you have multiple data sets in a repository use `--prefix` to select the workspace scope.

## Where to look for examples in this repository

+ `QUICKSTART.md` — quick start and first-run setup
+ `EXAMPLES.md` — practical command examples and scripts
+ `DATA_SYNCING.md` — detailed sync and GitHub workflows

## Related documentation

- `README.md` — project overview, installation, and architecture
- `PLUGIN_GUIDE.md` — plugin development and examples
- `GIT_WORKFLOW.md` — recommended git workflow for syncing JSONL data
- `MULTI_PROJECT_GUIDE.md` — using prefixes and multi-project setups
- `IMPLEMENTATION_SUMMARY.md` — design notes and implementation details
- `tests/README.md` — testing guide for running and authoring tests
- `MIGRATING_FROM_BEADS.md` — migration notes for users coming from Beads

If you find a command that's missing an example or you need an example tailored to your repository (prefixes, repo names, or CI usage), open an issue or ask for a focused example and I will add it.
