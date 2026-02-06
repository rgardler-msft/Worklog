import type { StatusStageValidationRules } from './status-stage-validation.js';
import { isStatusStageCompatible } from './status-stage-validation.js';

export interface UpdateDialogItemState {
  status?: string;
  stage?: string;
  priority?: string;
  comment?: string;
}

export interface UpdateDialogSelections {
  statusIndex: number;
  stageIndex: number;
  priorityIndex: number;
}

export interface UpdateDialogUpdatesResult {
  updates: Record<string, string>;
  hasChanges: boolean;
  comment?: string;
}

const resolveSelection = (values: string[], idx: number): string | undefined => {
  if (idx < 0 || idx >= values.length) return undefined;
  return values[idx];
};

export function buildUpdateDialogUpdates(
  item: UpdateDialogItemState,
  selections: UpdateDialogSelections,
  values: {
    statuses: string[];
    stages: string[];
    priorities: string[];
  },
  rules?: StatusStageValidationRules,
  // Optional: new comment text entered in multiline textbox. When provided
  // it will be included in the generated updates payload under `comment`.
  newComment?: string
): UpdateDialogUpdatesResult {
  const updates: Record<string, string> = {};

  const nextStatus = resolveSelection(values.statuses, selections.statusIndex);
  const nextStage = resolveSelection(values.stages, selections.stageIndex);
  const nextPriority = resolveSelection(values.priorities, selections.priorityIndex);

  if (!isStatusStageCompatible(nextStatus, nextStage, rules)) {
    return { updates: {}, hasChanges: false };
  }

  if (nextStatus && nextStatus !== item.status) updates.status = nextStatus;
  if (nextStage && nextStage !== item.stage) updates.stage = nextStage;
  if (nextPriority && nextPriority !== item.priority) updates.priority = nextPriority;

  // Handle optional comment field. The UI may provide a multiline textbox
  // whose contents are passed here as `newComment`. Comments are stored as
  // separate comment records, not fields on the work item itself. To keep
  // the `updates` payload focused on work item fields, return the comment as
  // a separate result property so callers can create a comment with
  // `db.createComment` when present.
  if (typeof newComment === 'string' && newComment.trim() !== '') {
    return {
      updates,
      hasChanges: Object.keys(updates).length > 0,
      comment: newComment,
    };
  }

  return {
    updates,
    hasChanges: Object.keys(updates).length > 0,
  };
}
