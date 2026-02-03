import { describe, it, expect } from 'vitest';
import {
  getAllowedStagesForStatus,
  getAllowedStatusesForStage,
  isStatusStageCompatible,
} from '../../src/tui/status-stage-validation.js';
import {
  STATUS_STAGE_COMPATIBILITY,
  STAGE_STATUS_COMPATIBILITY,
} from '../../src/tui/status-stage-rules.js';

describe('Status/Stage Validation Helper', () => {
  const rules = {
    statusStage: STATUS_STAGE_COMPATIBILITY,
    stageStatus: STAGE_STATUS_COMPATIBILITY,
  };

  it('returns allowed stages for status', () => {
    expect(getAllowedStagesForStatus('open', rules)).toEqual([
      '',
      'idea',
      'prd_complete',
      'plan_complete',
      'in_progress',
    ]);
  });

  it('returns allowed statuses for stage', () => {
    expect(getAllowedStatusesForStage('in_review', rules)).toEqual(['completed']);
  });

  it('accepts valid status/stage pairs', () => {
    expect(isStatusStageCompatible('completed', 'done', rules)).toBe(true);
    expect(isStatusStageCompatible('blocked', 'idea', rules)).toBe(true);
  });

  it('rejects invalid status/stage pairs', () => {
    expect(isStatusStageCompatible('completed', 'idea', rules)).toBe(false);
    expect(isStatusStageCompatible('deleted', 'in_review', rules)).toBe(false);
  });
});
