# Worklog CLI Reference (wl / worklog / wf)

This document describes the Worklog CLI commands and includes examples. Plugin commands can be added at runtime; to see any plugins available in your environment run `wl --help` (or `worklog --help` or `wf --help`). The layout follows the grouped output produced by `wl --help` so entries match the CLI ordering.

## Global options

These options apply to any command:

- `-V, --version` — Print the CLI version.
- `--json` — Produce machine-readable JSON output instead of human text.
- `--verbose` — Enable verbose output (extra timing / debug info where supported).
- `-F, --format <format>` — Choose human display format for work items: `concise`, `normal`, `full`, `raw`.
- `-w, --watch [seconds]` — Rerun the command every N seconds (default: 5).


These flags control overall CLI behavior: output format (JSON vs human), verbosity for debugging, the display format for human-readable commands, and auto-refresh via watch mode. Use `--json` for automation and `--format` when you need more or less detail in terminal output.


---

## Issue Management

Issue Management commands let you create, update, delete, comment on, and close work items. Use these for day-to-day work item lifecycle tasks: creating new tasks or bugs, recording progress, adding notes, and closing completed work.

### `create` [options]

Create a new work item.

Options:

- `-t, --title <title>` (required) — Title of the work item.
- `-d, --description <description>` — Description text (optional; defaults to empty).
- `--description-file <file>` — Read description from a file (optional).
- `-s, --status <status>` — Status value from config defaults (optional; default: `open`).
- `-p, --priority <priority>` — `low|medium|high|critical` (optional; default: `medium`).
- `-P, --parent <parentId>` — Parent work item ID (optional).
- `--tags <tags>` — Comma-separated tags (optional).
- `-a, --assignee <assignee>` — Assignee name (optional).
- `--stage <stage>` — Stage value from config defaults (optional).
- `--risk <risk>` — Risk level: `Low|Medium|High|Severe` (optional; no default).
- `--effort <effort>` — Effort level: `XS|S|M|L|XL` (optional; no default).
- `--issue-type <issueType>` — Interoperability: issue type (optional).
- `--created-by <createdBy>` — Interoperability: created by (optional).
- `--deleted-by <deletedBy>` — Interoperability: deleted by (optional).
- `--delete-reason <deleteReason>` — Interoperability: delete reason (optional).
- `--needs-producer-review <true|false>` — Set needsProducerReview flag (true|false|yes|no) (optional).
- `--prefix <prefix>` — Override default ID prefix (repo-local scope) (optional).
- `--json` — Output JSON (optional).

Examples:

```sh
wl create -t "Fix login bug"
wl create -t "Add telemetry" -d "Add event for signup" -p high -a alice --tags telemetry,signup
wl create -t "High-risk task" --risk High --effort M
wl --json create -t "Investigate CI flakes" -d "Flaky tests seen" -p high
```

Notes:

- Status and stage values are configured in `.worklog/config.defaults.yaml` under `statuses` and `stages`.

### `update` [options] <id...>

Update fields on one or more existing work items. Accepts multiple IDs. Options mirror `create` for updatable fields, plus `--description-file <file>` (read description from a file), `--needs-producer-review <true|false>` (set needsProducerReview flag), and `--do-not-delegate <true|false>` (set or clear the do-not-delegate tag).

Example:

```sh
wl update WL-ABC123 -t "New title" -p low
wl update WL-ABC123 -s in-progress -a "bob"
wl update WL-ABC123 --risk High --effort XS
```

New: toggle the do-not-delegate tag (prevents automation from auto-assigning the item):

```sh
wl update WL-ABC123 --do-not-delegate true   # add tag
wl update WL-ABC123 --do-not-delegate false  # remove tag
```

### `reviewed` <id> [value]

Toggle or set the `needsProducerReview` flag on a work item. If `value` is omitted, it toggles the current value.

Options:

- `--prefix <prefix>` — Operate on a specific prefix (optional).

Examples:

```sh
wl reviewed WL-ABC123           # toggle flag
wl reviewed WL-ABC123 true      # set to true
wl reviewed WL-ABC123 false     # set to false
wl --json reviewed WL-ABC123    # JSON output with updated work item
```

### `delete` [options] <id>

Delete a work item (marks as deleted): this sets the work item status to `deleted` in the local database. If you prefer to set the status explicitly, use `wl update <id> -s deleted` instead.

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

- `create|add <workItemId>` — Create a comment. Required: `-a, --author`, `-c, --comment`. Optional: `--body <body>` (alias for `--comment`), `-r, --references <references>` (comma-separated list of references: work item IDs, file paths, or URLs).
- `list <workItemId>` — List comments for a work item.
- `show <commentId>` — Show a single comment.
- `update <commentId>` — Update a comment's fields. Options: `-c, --comment`, `-a, --author`, `-r, --references`.
- `delete <commentId>` — Delete a comment.

Examples:

```sh
wl comment create WL-ABC123 -a alice -c "I narrowed this down to the auth layer."
wl comment add WL-ABC123 -a alice --body "Using the add alias."
wl comment create WL-ABC123 -a alice -c "See related" -r "WL-DEF456,src/auth.ts"
wl comment list WL-ABC123
wl comment show CMT-0001
wl comment update CMT-0001 -c "Updated content" -a alice
wl comment delete CMT-0001
```

### `close` [options] <ids...>

Close one or more work items and optionally record a close reason as a comment.

**Automatic unblocking:** When a work item is closed, any dependents that were blocked
solely by this item are automatically unblocked (their status changes from `blocked` to
`open`). If a dependent has multiple blockers and other blockers remain active, it stays
blocked. This behaviour is identical in both the CLI and TUI — both paths use the shared
`reconcileDependentsForTarget()` service in the database layer.

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
- `dep add` automatically sets `itemId` status to `blocked` when the dependency is active (i.e. `dependsOnId` is not completed or deleted).
- `dep rm` warns and exits 0 when ids are missing.
- `dep list` warns and exits 0 when ids are missing.
- `dep list --outgoing` shows only outbound dependencies.
- `dep list --incoming` shows only inbound dependencies.

**Automatic unblocking:** Dependents are automatically unblocked when all their blockers
become inactive (completed or deleted). This reconciliation happens via `db.update()` and
`db.delete()` — any status or stage change triggers the reconciliation logic. See
[Dependency Reconciliation](docs/dependency-reconciliation.md) for developer details.

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

Suggest the next work item(s) to work on. Non-actionable items (deleted, completed, in-review, in-progress, dependency-blocked) are excluded by default.

#### Automatic re-sort

By default, `wl next` re-sorts all active items by score before selecting candidates. This ensures that recently created or re-prioritized items are immediately reflected in the selection order without requiring a manual `wl re-sort`. The re-sort uses the same scoring logic as `wl re-sort` (priority weight, age, and optional recency policy).

Pass `--no-re-sort` to skip the automatic re-sort and preserve the current `sort_index` order. This is useful when you have manually adjusted `sort_index` values and want to preserve that ordering.

The `--recency-policy` flag controls how recently updated items are weighted during the re-sort step. The default is `ignore` (no recency bias).

#### Ranking precedence

When multiple candidate items exist, `wl next` ranks them using the following criteria (highest weight first):

1. **Priority** — higher-priority items always rank above lower-priority items.
2. **Blocks high-priority work** — among equal-priority candidates, an item that is a prerequisite for a `high` or `critical` downstream item is preferred. This ensures that unblocking high-value work takes precedence over unrelated tasks at the same priority.
3. **Blocked penalty** — items with active dependency blockers are excluded by default (see `--include-blocked`).
4. **Tie-breakers** — sort_index hierarchy position, then age (older items first) break remaining ties.

Items with `status: 'blocked'` that have `critical` priority trigger a special escalation path: their direct blockers are surfaced immediately, bypassing the general ranking logic.

#### Backward compatibility

The `--include-blocked` flag behavior is unchanged. The ranking boost only affects ordering among candidates that are already considered (i.e., unblocked items by default).

Options:

`-a, --assignee <assignee>` (optional)
`-s, --search <term>` (optional)
`-n, --number <n>` — Number of items to return (optional; default: `1`).
`--include-in-review` — Include items with status `blocked` and stage `in_review` (optional).
`--include-blocked` — Include dependency-blocked items (excluded by default).
`--no-re-sort` — Skip automatic re-sort before selection, preserving current `sort_index` order (optional).
`--recency-policy <policy>` — Recency handling for the re-sort step: `prefer`, `avoid`, or `ignore` (optional; default: `ignore`).
`--prefix <prefix>` (optional)

Examples:

```sh
wl next
wl next -n 3
wl next -a alice --search "bug"
wl next --include-blocked
wl next --no-re-sort
wl next --recency-policy prefer
```

### `in-progress` [options]

List all in-progress work items in a dependency tree.

Options:

`-a, --assignee <assignee>` — Filter by assignee (optional).
`--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl in-progress
wl in-progress -a alice
```

### `recent` [options]

Show most recently changed work items.

Options:

`-n, --number <n>` — Number of recent items to show (optional).
`-c, --children` — Also show children (optional).
`--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl recent
wl recent -n 10
wl recent -c
```

### `list` [options] [search]

List work items, optionally filtered and/or full-text searched.

Options:

`-s, --status <status>` (optional)
`-p, --priority <priority>` (optional)
`--parent <id>` — Filter by parent ID (direct children only) (optional).
`--tags <tags>` (optional)
`-a, --assignee <assignee>` (optional)
`-n, --number <n>` (optional) — Limit the number of items returned
`--stage <stage>` (optional)
`--deleted` (optional) — Include items with `deleted` status in the output (hidden by default).
`--needs-producer-review [value]` (optional; defaults to `true` when omitted; accepts true|false|yes|no)
`--prefix <prefix>` (optional)
`--json` (optional)

Examples:

```sh
wl list
wl list -s open -p high
wl search "signup"
wl -F concise list -s in-progress
wl --json list -s open --tags backlog
wl list --needs-producer-review
```

---

### `search` <query> [options]

Full-text search over work items using FTS5 (title, description, comments, tags). Returns ranked results with relevance snippets. Falls back to application-level search when FTS5 is unavailable.

**ID-aware search:** Queries that contain work item IDs (full, partial, or unprefixed) are detected automatically:

- **Exact ID** — `wl search WL-0MM0AN2IT0OOC2TW` returns the matching item as the top result.
- **Unprefixed ID** — `wl search 0MM0AN2IT0OOC2TW` resolves using the repository's configured prefix (e.g. `WL`) and behaves the same as the prefixed form.
- **Partial ID** — Tokens of 8+ alphanumeric characters are matched as substrings against all work item IDs; partial matches appear below exact matches.
- **Mixed queries** — `wl search WL-XXXXX some text` returns the ID match first, followed by FTS results for the full query (duplicates removed).

Options:

`-s, --status <status>` (optional) — Filter results by status
`-p, --priority <priority>` (optional) — Filter by priority
`--parent <id>` (optional) — Filter results by parent work item id
`--tags <tags>` (optional) — Filter by tags (comma-separated)
`-a, --assignee <assignee>` (optional) — Filter by assignee
`--stage <stage>` (optional) — Filter by stage
`--deleted` (optional) — Include deleted items in results
`--needs-producer-review [value]` (optional) — Filter by needsProducerReview flag (true|false|yes|no; default true when omitted)
`--issue-type <type>` (optional) — Filter by issue type
`-l, --limit <n>` (optional) — Maximum number of results (default: 20)
`--rebuild-index` (optional) — Rebuild the FTS index from scratch before searching
`--prefix <prefix>` (optional)
`--json` (optional) — Output structured JSON with `id`, `title`, `status`, `priority`, `score`, `snippet`, `matchedField`

Examples:

```sh
wl search "database corruption"
wl search "memory leak" --status open
wl search "bug" --priority high --assignee alice
wl search "migration" --stage in_progress
wl search "authentication" --tags security,auth --limit 5
wl search "feature" --issue-type epic
wl search "review" --needs-producer-review
wl --json search "cli refactor"
wl search "rebuild" --rebuild-index

# ID-aware search
wl search WL-0MM0AN2IT0OOC2TW              # exact ID lookup
wl search 0MM0AN2IT0OOC2TW                  # unprefixed ID (prefix resolved automatically)
wl search 0MM0AN2I                           # partial ID substring match (>= 8 chars)
wl --json search WL-0MM0AN2IT0OOC2TW        # JSON output with ID match as top result
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
   Additional push options:

   - `--all` — Force a full push of all items, ignoring the last-push timestamp. Useful when you want to re-sync everything.
   - `--force` — **Deprecated** alias for `--all`. Bypass the pre-filter and process all work items regardless of whether they changed since the last push.
   - `--no-update-timestamp` — Do not write the repository last-push timestamp after a successful push. Use this when you want to run a push but avoid advancing the "last pushed" watermark.
- `import` — Import updates from GitHub Issues. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--since <ISO timestamp>`, `--create-new`, `--prefix <prefix>`.
- `delegate <id>` — Delegate a work item to GitHub Copilot. Pushes the item to GitHub, assigns the resulting issue to `@copilot`, and updates local status/assignee. Options: `--repo <owner/name>`, `--label-prefix <prefix>`, `--force` (override the `do-not-delegate` tag). In the TUI, press **g** on a focused item for the same flow with a confirmation modal.

Examples:

```sh
wl github push --repo myorg/myrepo
wl gh import --repo myorg/myrepo --since 2025-12-01T00:00:00Z --create-new

# Force a full re-sync (bypass pre-filter)
wl github push --repo myorg/myrepo --all

# Push but do not update the recorded last-push timestamp
wl github push --repo myorg/myrepo --no-update-timestamp
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

Additionally, database schema upgrades are available via `wl doctor upgrade` (preview with `--dry-run`, apply with `--confirm`).

Examples:

```sh
wl migrate sort-index --dry-run
wl migrate sort-index --gap 100
wl doctor upgrade --dry-run       # Preview pending schema migrations
wl doctor upgrade --confirm       # Apply pending schema migrations (creates backups, requires confirmation)
```

### `doctor` [options]

Validate work items against config-driven status/stage rules. Reports invalid values or incompatible combinations.

For detailed migration policy, backup behavior, and CI guidance, see [DOCTOR_AND_MIGRATIONS.md](DOCTOR_AND_MIGRATIONS.md).

Options:

- `--fix` — Apply safe fixes and prompt for non-safe findings (optional).
- `--prefix <prefix>` — Override the default prefix (optional).
- `--json` — Output findings as JSON (optional).

Subcommands:

- `upgrade [options]` — Preview or apply pending database schema migrations. Options: `--dry-run` (preview without applying), `--confirm` (apply non-interactively).
- `prune [options]` — Prune soft-deleted work items older than a specified age. Options: `--days <n>` (age threshold in days), `--dry-run` (show what would be pruned).

Examples:

```sh
wl doctor
wl doctor --fix
wl --json doctor
wl doctor upgrade --dry-run       # Preview pending schema migrations
wl doctor upgrade --confirm       # Apply pending schema migrations
wl doctor prune --days 30         # Prune items deleted more than 30 days ago
wl doctor prune --dry-run         # Preview which items would be pruned
```

JSON output is a raw array of findings. Each finding includes:
`checkId`, `type`, `severity`, `itemId`, `message`, `proposedFix`, `safe`, `context`.

### `re-sort` [options]

Recompute `sort_index` values for active work items (excluding completed/deleted) using the current database values.

Options:

- `--dry-run` — Print the updates without applying them.
- `--gap <gap>` — Integer gap between consecutive `sort_index` values (optional; default: `100`).
- `--recency <policy>` — Recency handling for score ordering: `prefer|avoid|ignore` (optional; default: `avoid`).
- `--prefix <prefix>` — Override the default prefix (optional).

Examples:

```sh
wl re-sort --dry-run
wl re-sort --gap 100
wl re-sort --recency prefer
```

### `unlock` [options]

Inspect or remove a stale worklog lock file. When a `wl` command crashes or is killed, it may leave behind a lock file that blocks subsequent commands. Use `wl unlock` to inspect the lock and remove it.

Options:

- `--force` — Remove the lock file without prompting for confirmation.
- `--json` — Output machine-readable JSON.

Examples:

```sh
wl unlock                # show lock status and suggest removal
wl unlock --force        # remove the lock file without prompting
wl --json unlock         # JSON output with lock metadata
```

JSON output includes `success`, `lockFound`, `removed`, and `lockInfo` (with `pid`, `hostname`, `acquiredAt`, `age`) when a lock file is present.

Notes:

- If no lock file exists, the command prints "No lock file found" and exits 0.
- If the lock file is corrupted (unparseable metadata), `--force` is required to remove it.
- If the lock is held by a still-running process, the command warns but still allows removal with confirmation or `--force`.

---

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
 - `ampa` — AMPA plugin: manage AMPA containers and workspace tasks (start, stop, status, run, list, start-work, finish-work).

Examples:

```sh
wl ampa start                 # start AMPA services for this repo
wl ampa status                # show AMPA service status
wl ampa list                  # list available AMPA containers/tasks
wl ampa start-work WL-012     # attach/start AMPA work for a specific work item
```

---

## Other

Other commands cover repository bootstrap and local system status. Use these to initialize Worklog in a repo, check system health, or get help on a command.

### `init`

Initialize Worklog configuration in the repository (creates `.worklog` and default config). `wl init` also installs `AGENTS.md` in the project root with a pointer line to the global `AGENTS.md`. If `AGENTS.md` already exists, it prompts before inserting the pointer and preserves the existing content (unless you pass `--agents-template` for unattended runs). When workflow templates are available, `wl init` prompts you to choose between no formal workflow, a basic Worklog-aware workflow, or manual management (unless you pass `--workflow-inline` for unattended runs).

Options:

- `--project-name <name>` — Project name (optional).
- `--prefix <prefix>` — Issue ID prefix (optional).
- `--auto-export <yes|no>` — Auto-export data to JSONL after changes (optional).
- `--auto-sync <yes|no>` — Auto-sync data to git after changes (optional).
- `--agents-template <overwrite|append|skip>` — What to do when AGENTS.md exists (optional). Append inserts the pointer line at the top while keeping existing content.
- `--workflow-inline <yes|no>` — Answer the workflow prompt (yes chooses the basic workflow option; no chooses no formal workflow). Omit to prompt interactively.
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

+ `README.md` — quick start and first-run setup
+ `EXAMPLES.md` — practical command examples and scripts
+ `DATA_SYNCING.md` — detailed sync and GitHub workflows

## Related documentation

- `README.md` — project overview, quick start, and documentation index
- `CONFIG.md` — configuration system and setup options
- `DATA_FORMAT.md` — JSONL data format, storage architecture, and field reference
- `API.md` — REST API endpoints and usage
- `PLUGIN_GUIDE.md` — plugin development and examples
- `GIT_WORKFLOW.md` — recommended git workflow for syncing JSONL data
- `MULTI_PROJECT_GUIDE.md` — using prefixes and multi-project setups
- `IMPLEMENTATION_SUMMARY.md` — design notes and implementation details
- `tests/README.md` — testing guide for running and authoring tests
- `MIGRATING_FROM_BEADS.md` — migration notes for users coming from Beads

If you find a command that's missing an example or you need an example tailored to your repository (prefixes, repo names, or CI usage), open an issue or ask for a focused example and I will add it.
