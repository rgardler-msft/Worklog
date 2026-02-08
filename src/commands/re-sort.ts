/**
 * Re-sort command - recompute sort_index ordering
 */

import type { PluginContext } from '../plugin-types.js';
import type { ResortOptions } from '../cli-types.js';

const DEFAULT_SORT_GAP = 100;
const DEFAULT_RECENCY_POLICY = 'avoid';
const VALID_RECENCY_POLICIES = new Set(['prefer', 'avoid', 'ignore']);

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('re-sort')
    .description('Re-sort active work items based on current database state')
    .option('--dry-run', 'Preview changes without writing to the database')
    .option('--gap <gap>', `Gap between sort_index values (default: ${DEFAULT_SORT_GAP})`, String(DEFAULT_SORT_GAP))
    .option('--recency <policy>', `Recency handling for score ordering (prefer|avoid|ignore). Default: ${DEFAULT_RECENCY_POLICY}`, DEFAULT_RECENCY_POLICY)
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: ResortOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const dryRun = Boolean(options.dryRun);
      const gap = parseInt(options.gap || String(DEFAULT_SORT_GAP), 10);
      const recency = (options.recency || DEFAULT_RECENCY_POLICY).toLowerCase();

      if (Number.isNaN(gap) || gap <= 0) {
        output.error('Gap must be a positive integer', { success: false, error: 'Gap must be a positive integer' });
        process.exit(1);
      }

      if (!VALID_RECENCY_POLICIES.has(recency)) {
        output.error('Recency must be one of: prefer, avoid, ignore', { success: false, error: 'Recency must be one of: prefer, avoid, ignore' });
        process.exit(1);
      }

      const ordered = db
        .getAllOrderedByScore(recency as 'prefer' | 'avoid' | 'ignore')
        .filter(item => item.status !== 'completed' && item.status !== 'deleted');

      if (dryRun) {
        const preview = db.previewSortIndexOrderForItems(ordered, gap);
        if (utils.isJsonMode()) {
          output.json({ success: true, dryRun: true, gap, recency, count: preview.length, items: preview });
          return;
        }

        console.log(`Dry run: ${preview.length} item(s) would be updated.`);
        preview.forEach((entry: { id: string; title: string; sortIndex: number }) => {
          console.log(`${entry.id} ${entry.title} -> ${entry.sortIndex}`);
        });
        return;
      }

      const result = db.assignSortIndexValuesForItems(ordered, gap);
      if (utils.isJsonMode()) {
        output.json({ success: true, updated: result.updated, gap, recency });
        return;
      }
      console.log(`Resort complete. Updated ${result.updated} item(s).`);
    });
}
