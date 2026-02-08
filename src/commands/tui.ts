/**
 * TUI command - interactive tree view for work items
 */

import type { PluginContext } from '../plugin-types.js';
import { TuiController } from '../tui/controller.js';
import {
  rebuildTreeState as state_rebuildTreeState,
  createTuiState as state_createTuiState,
  buildVisibleNodes as state_buildVisibleNodes,
  filterVisibleItems as state_filterVisibleItems,
  isClosedStatus as state_isClosedStatus,
} from '../tui/state.js';
import type { TuiState } from '../tui/state.js';

export const isClosedStatus = state_isClosedStatus;
export const filterVisibleItems = state_filterVisibleItems;
export const rebuildTreeState = state_rebuildTreeState;
export const createTuiState = state_createTuiState;
export const buildVisibleNodes = state_buildVisibleNodes;
export type { TuiState };

export default function register(ctx: PluginContext): void {
  const controller = new TuiController(ctx);
  const { program } = ctx;

  program
    .command('tui')
    .description('Interactive TUI: browse work items in a tree (use --in-progress to show only in-progress)')
    .option('--in-progress', 'Show only in-progress items')
    .option('--all', 'Include completed/deleted items in the list')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (options: { inProgress?: boolean; prefix?: string; all?: boolean }) => {
      await controller.start(options);
    });
}
