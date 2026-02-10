Worklog Migration Policy and `wl doctor upgrade`

Overview
--------
This document explains how to inspect and apply database schema migrations for Worklog using
the `wl doctor upgrade` command and the repository migration runner. Migrations are centralized
in `src/migrations` and must be applied explicitly to avoid silent schema changes on production
databases.

Backups
-------
- Before applying migrations the runner creates a timestamped backup of the database in
  `<dbdir>/backups/`.
- The runner prunes backups to keep the most recent 5 backups to limit disk usage.

Running `wl doctor upgrade`
---------------------------
Examples:

- Preview pending migrations (dry-run):

  `wl doctor upgrade --dry-run`

  This lists pending migrations without applying them.

- Apply pending migrations interactively:

  `wl doctor upgrade`

  The command lists safe migrations and prompts for confirmation before applying.

- Apply pending migrations non-interactively:

  `wl doctor upgrade --confirm`

  Use `--confirm` to skip the interactive prompt. Note: the command still enforces the
  backup creation behavior and will fail on errors.

Flags (current behaviour)
-------------------------
- `--dry-run` — list pending migrations without applying them.
- `--confirm` — apply migrations non-interactively (no prompt).

If a flag described here is not implemented in your local `wl` version, the command will
document the planned behaviour and fall back to the safe (dry-run) behaviour by default.

Backups & Safety
----------------
- Backups are mandatory. The migration runner will not apply migrations without creating a
  backup first.
- The runner prunes backups to keep only the last 5.

CI / Automation
---------------
- By default CI should not auto-apply migrations to persistent production databases. Use a
  dedicated migration step that runs `wl doctor upgrade --dry-run` and fails the build if
  pending migrations are found.
- To allow non-interactive application (risky), set an explicit environment variable such as
  `WL_AUTO_MIGRATE=true` and run `wl doctor upgrade --confirm` in a controlled environment.
  This repository recommends making the migration step explicit and auditable in CI.

Adding a migration
------------------
- Add SQL migration files and a migration descriptor to `src/migrations` following the
  repository migration conventions. Ensure `safe` is set appropriately for the migration.
- Update tests and docs describing the behavioural change.

Troubleshooting
---------------
- If `wl doctor upgrade` reports pending migrations but you cannot apply them, inspect the
  migration descriptor and review the SQL for potential destructive operations. Run a dry-run
  first and verify backups.
- To inspect the workitems schema directly use sqlite3: `sqlite3 path/to/worklog.db "PRAGMA table_info('workitems')"`

Reference
---------
- Migrations runner: `src/migrations/index.ts`
- Migration descriptors: `src/migrations/*`
- Migration application: `runMigrations` creates backups and prunes to the last 5 backups.
