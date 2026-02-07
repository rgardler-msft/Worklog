# Status/Stage Validation Rules Inventory

## Purpose
This document inventories all known status/stage validation rules, their sources,
and any gaps/ambiguities. It is intended to be the single reference for shared
validation helpers and UI wiring.

## Status and Stage Values
- Statuses (canonical): open, in-progress, blocked, completed, deleted
  - Source: src/tui/status-stage-rules.ts
  - Type: src/types.ts
- Stages (canonical): (blank), idea, prd_complete, plan_complete, intake_complete, in_progress, in_review, done
  - Source: templates/AGENTS.md, templates/WORKFLOW.md, src/tui/status-stage-rules.ts
  - Defaulting behavior on create/import: blank stage
    - Source: src/database.ts (create) and src/jsonl.ts (import default)

## Compatibility Rules (Explicit)
### Status -> Allowed Stages
Defined in src/tui/status-stage-rules.ts.
- open -> '', idea, prd_complete, plan_complete, intake_complete, in_progress
- in-progress -> in_progress
- blocked -> '', idea, prd_complete, plan_complete, intake_complete, in_progress
- completed -> in_review, done
- deleted -> ''

### Stage -> Allowed Statuses
Derived in src/tui/status-stage-rules.ts from status compatibility.
- '' -> open, blocked, deleted
- idea -> open, blocked
- prd_complete -> open, blocked
- plan_complete -> open, blocked
- intake_complete -> open, blocked
- in_progress -> open, in-progress, blocked
- in_review -> completed
- done -> completed

### Update Dialog Validation
TUI update dialog rejects invalid status/stage combinations.
- Source: src/tui/update-dialog-submit.ts (buildUpdateDialogUpdates)
- Tests: tests/tui/tui-update-dialog.test.ts
  - Rejects invalid status/stage combinations.
  - Accepts compatible updates and applies changes.

### Close Dialog Status/Stage Mapping
Close dialog sets status/stage pairs as follows:
- Close (in_review) -> status=completed, stage=in_review
- Close (done) -> status=completed, stage=done
- Close (deleted) -> status=deleted, stage=''
- Source: src/tui/status-stage-rules.ts (STATUS_STAGE_RULE_NOTES)
- UI options: src/tui/components/dialogs.ts

## Dependency Rules (Implied)
Adding/removing dependency edges affects status based on the dependency stage.
- On dep add: if dependsOn.stage not in [in_review, done], set item status=blocked
  - Source: src/commands/dep.ts (add)
- On dep remove: if no remaining deps with stage not in [in_review, done], set item status=open
  - Source: src/commands/dep.ts (rm)

## Selection/Filtering Rules (Implied)
The next-item selection logic treats in_review specially and filters statuses.
- Exclude status=blocked and stage=in_review by default (unless --include-in-review)
  - Source: src/commands/next.ts (option), src/database.ts (findNextWorkItemFromItems)
- Filter out status=deleted in next-item selection
  - Source: src/database.ts (findNextWorkItemFromItems)

## CLI/Docs References
- CLI docs list statuses and stage options without compatibility rules.
  - Source: CLI.md
- Workflow templates reference stages, not status/stage compatibility.
  - Source: templates/AGENTS.md, templates/WORKFLOW.md

## Gaps and Ambiguities
- CLI update/create paths do not enforce status/stage compatibility.
  - Observed: src/commands/update.ts allows any status/stage values.
  - Behavior: database stores values without validation.
- Stage value "blocked" appears in tests but is not in canonical stage list.
  - Observed: tests/tui/tui-update-dialog.test.ts uses stage='blocked' in Update Dialog Functions
  - Not present in src/tui/status-stage-rules.ts stages list.
- Status default and stage default are set during create/import, but no validation
  is applied on update or import beyond missing-field normalization.

## Examples
- Valid: status=open, stage=idea
- Valid: status=in-progress, stage=in_progress
- Valid: status=completed, stage=in_review
- Invalid (TUI rejected): status=completed, stage=idea
- Invalid (TUI rejected): status=deleted, stage=in_review
