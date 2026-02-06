import type { BlessedList, BlessedTextarea } from './types.js';

export interface UpdateDialogFocusManager {
  getIndex: () => number;
  focusIndex: (idx: number) => void;
  cycle: (direction: 1 | -1) => void;
}

export function createUpdateDialogFocusManager(fields: Array<BlessedList | BlessedTextarea>): UpdateDialogFocusManager {
  let index = 0;

  const clampIndex = () => {
    if (fields.length === 0) {
      index = 0;
      return;
    }
    index = Math.max(0, Math.min(index, fields.length - 1));
  };

  const focusIndex = (idx: number) => {
    index = idx;
    clampIndex();
    const target = fields[index];
    if (target) {
      target.focus();
    }
  };

  const cycle = (direction: 1 | -1) => {
    if (fields.length === 0) return;
    const nextIndex = (index + direction + fields.length) % fields.length;
    focusIndex(nextIndex);
  };

  return {
    getIndex: () => index,
    focusIndex,
    cycle,
  };
}
