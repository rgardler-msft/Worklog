import type { StatusStageValidationRules } from './status-stage-validation.js';
import { isStatusStageCompatible } from './status-stage-validation.js';

export interface UpdateDialogItemState {
  status?: string;
  stage?: string;
  priority?: string;
}

export interface UpdateDialogSelections {
  statusIndex: number;
  stageIndex: number;
  priorityIndex: number;
}

export interface UpdateDialogUpdatesResult {
  updates: Record<string, string>;
  hasChanges: boolean;
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
  rules?: StatusStageValidationRules
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

  return {
    updates,
    hasChanges: Object.keys(updates).length > 0,
  };
}
