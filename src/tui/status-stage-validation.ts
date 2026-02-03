import type { WorkItemStatus } from '../types.js';
import { STATUS_STAGE_COMPATIBILITY, STAGE_STATUS_COMPATIBILITY } from './status-stage-rules.js';

export interface StatusStageValidationRules {
  statusStage?: Record<string, readonly string[]>;
  stageStatus?: Record<string, readonly string[]>;
}

const resolveStatusStageRules = (rules?: StatusStageValidationRules) =>
  rules?.statusStage ?? STATUS_STAGE_COMPATIBILITY;

const resolveStageStatusRules = (rules?: StatusStageValidationRules) =>
  rules?.stageStatus ?? STAGE_STATUS_COMPATIBILITY;

export const getAllowedStagesForStatus = (
  status?: string,
  rules?: StatusStageValidationRules
): readonly string[] => {
  if (!status) return [];
  const statusStageRules = resolveStatusStageRules(rules);
  return statusStageRules[status as WorkItemStatus] ?? [];
};

export const getAllowedStatusesForStage = (
  stage?: string,
  rules?: StatusStageValidationRules
): readonly string[] => {
  if (stage === undefined) return [];
  const stageStatusRules = resolveStageStatusRules(rules);
  return stageStatusRules[stage] ?? [];
};

export const isStatusStageCompatible = (
  status?: string,
  stage?: string,
  rules?: StatusStageValidationRules
): boolean => {
  if (!status || stage === undefined) return true;
  const allowedStages = getAllowedStagesForStatus(status, rules);
  if (allowedStages.length > 0 && !allowedStages.includes(stage)) return false;
  const allowedStatuses = getAllowedStatusesForStage(stage, rules);
  if (allowedStatuses.length > 0 && !allowedStatuses.includes(status)) return false;
  return true;
};
