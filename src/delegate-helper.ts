/**
 * Delegate orchestration helper — shared by CLI and TUI.
 *
 * Extracts the delegate flow (guard rails -> push -> assign -> local state
 * update) from the CLI action handler into a reusable async function that
 * returns a structured result.  Never calls `process.exit()` or writes to
 * `console.log`.
 */

import type { WorkItem, Comment } from './types.js';
import type { GithubConfig } from './github.js';

// ---------------------------------------------------------------------------
// Public result / option types
// ---------------------------------------------------------------------------

/** Structured result returned by `delegateWorkItem`. */
export interface DelegateResult {
  success: boolean;
  workItemId: string;
  issueNumber?: number;
  issueUrl?: string;
  pushed?: boolean;
  assigned?: boolean;
  /** Human-readable error key or message when `success` is false. */
  error?: string;
  /** Warning messages that were produced but did not prevent delegation. */
  warnings?: string[];
}

/** Options accepted by `delegateWorkItem`. */
export interface DelegateOptions {
  /** Override the do-not-delegate tag guard rail. */
  force?: boolean;
  /** Optional callback invoked at each major step of the delegate flow. */
  onProgress?: (step: string) => void;
}

// ---------------------------------------------------------------------------
// Minimal DB interface (avoids coupling to full WorklogDatabase)
// ---------------------------------------------------------------------------

/**
 * Subset of `WorklogDatabase` that `delegateWorkItem` depends on.  This
 * allows the TUI and tests to pass any object that satisfies the contract
 * without importing the full database module.
 */
export interface DelegateDb {
  get(id: string): WorkItem | null;
  getAll(): WorkItem[];
  getAllComments(): Comment[];
  getChildren(parentId: string): WorkItem[];
  update(id: string, input: Record<string, unknown>): WorkItem | null;
  upsertItems(items: WorkItem[]): void;
  createComment(input: {
    workItemId: string;
    author: string;
    comment: string;
  }): Comment | null;
}

// ---------------------------------------------------------------------------
// Dependency type declarations (avoids top-level import of heavy modules)
// ---------------------------------------------------------------------------

type UpsertFn = typeof import('./github-sync.js').upsertIssuesFromWorkItems;
type AssignFn = typeof import('./github.js').assignGithubIssueAsync;

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

/**
 * Execute the full delegate flow for a single work item:
 *
 * 1. Resolve item from DB (guard: not-found)
 * 2. Guard rail: do-not-delegate tag
 * 3. Guard rail: open children warning (non-blocking)
 * 4. Push item to GitHub via upsert
 * 5. Resolve GitHub issue number
 * 6. Assign @copilot
 * 7. On failure: add comment, re-push
 * 8. On success: update local state, re-push labels
 *
 * The function never throws under normal operation -- all error paths
 * return `{ success: false, error: ... }`.
 */
export async function delegateWorkItem(
  db: DelegateDb,
  githubConfig: GithubConfig,
  itemId: string,
  options: DelegateOptions = {},
  /** Optional override for upsertIssuesFromWorkItems (useful for testing). */
  _upsertFn?: UpsertFn,
  /** Optional override for assignGithubIssueAsync (useful for testing). */
  _assignFn?: AssignFn,
): Promise<DelegateResult> {
  const warnings: string[] = [];
  const progress = options.onProgress ?? (() => {});

  // ------------------------------------------------------------------
  // 1. Resolve work item
  // ------------------------------------------------------------------
  const item = db.get(itemId);
  if (!item) {
    return {
      success: false,
      workItemId: itemId,
      error: 'not-found',
    };
  }

  // ------------------------------------------------------------------
  // 2. Guard rail: do-not-delegate tag
  // ------------------------------------------------------------------
  if (Array.isArray(item.tags) && item.tags.includes('do-not-delegate')) {
    if (!options.force) {
      return {
        success: false,
        workItemId: itemId,
        error: 'do-not-delegate',
      };
    }
    warnings.push(
      `Work item ${itemId} has a "do-not-delegate" tag. Proceeding due to --force.`,
    );
  }

  // ------------------------------------------------------------------
  // 3. Guard rail: open children warning (non-blocking)
  // ------------------------------------------------------------------
  const children = db.getChildren(itemId);
  if (children.length > 0) {
    const nonClosedChildren = children.filter(
      (c) => c.status !== 'completed' && c.status !== 'deleted',
    );
    if (nonClosedChildren.length > 0) {
      warnings.push(
        `Work item ${itemId} has ${nonClosedChildren.length} open child item(s). Delegating only the specified item.`,
      );
    }
  }

  // ------------------------------------------------------------------
  // 4. Push item to GitHub
  // ------------------------------------------------------------------
  try {
    progress('Pushing to GitHub...');
    const upsert: UpsertFn =
      _upsertFn ??
      (await import('./github-sync.js')).upsertIssuesFromWorkItems;

    const comments = db.getAllComments();
    const { updatedItems } = await upsert(
      [item],
      comments.filter((c) => c.workItemId === item.id),
      githubConfig,
      () => {}, // no progress for single-item push
    );
    if (updatedItems.length > 0) {
      db.upsertItems(updatedItems);
    }

    // ----------------------------------------------------------------
    // 5. Resolve GitHub issue number
    // ----------------------------------------------------------------
    const refreshedItem = db.get(itemId);
    const issueNumber =
      refreshedItem?.githubIssueNumber ?? item.githubIssueNumber;
    if (!issueNumber) {
      return {
        success: false,
        workItemId: itemId,
        error: `Failed to resolve GitHub issue number for ${itemId} after push.`,
        pushed: true,
        assigned: false,
      };
    }

    // ----------------------------------------------------------------
    // 6. Assign @copilot
    // ----------------------------------------------------------------
    progress('Assigning @copilot...');
    const assign: AssignFn =
      _assignFn ?? (await import('./github.js')).assignGithubIssueAsync;

    const assignResult = await assign(githubConfig, issueNumber, '@copilot');

    const issueUrl = `https://github.com/${githubConfig.repo}/issues/${issueNumber}`;

    if (!assignResult.ok) {
      // ---------------------------------------------------------------
      // 7. Assignment failed -- add comment, re-push, do NOT update state
      // ---------------------------------------------------------------
      const failureMessage =
        `Failed to assign @copilot to GitHub issue #${issueNumber}: ${assignResult.error}. Local state was not updated.`;

      db.createComment({
        workItemId: itemId,
        author: 'wl-delegate',
        comment: failureMessage,
      });

      // Re-push to sync the failure comment
      const refreshedComments = db.getAllComments();
      await upsert(
        [db.get(itemId)!],
        refreshedComments.filter((c) => c.workItemId === itemId),
        githubConfig,
        () => {},
      );

      return {
        success: false,
        workItemId: itemId,
        issueNumber,
        issueUrl,
        pushed: true,
        assigned: false,
        error: assignResult.error,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // ----------------------------------------------------------------
    // 8. Assignment succeeded -- update local state and re-push labels
    // ----------------------------------------------------------------
    progress('Updating local state...');
    db.update(itemId, {
      status: 'in-progress',
      assignee: '@github-copilot',
      stage: 'in_progress',
    });

    const postAssignComments = db.getAllComments();
    await upsert(
      [db.get(itemId)!],
      postAssignComments.filter((c) => c.workItemId === itemId),
      githubConfig,
      () => {},
    );

    return {
      success: true,
      workItemId: itemId,
      issueNumber,
      issueUrl,
      pushed: true,
      assigned: true,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (error) {
    return {
      success: false,
      workItemId: itemId,
      error: (error as Error).message,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
}
