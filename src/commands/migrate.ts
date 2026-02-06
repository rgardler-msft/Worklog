/**
 * Migrate command - database migrations for Worklog
 */

import type { PluginContext } from '../plugin-types.js';
import type { MigrateOptions } from '../cli-types.js';

const DEFAULT_SORT_GAP = 100;

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const migrate = program
    .command('migrate')
    .description('Run Worklog database migrations');

  migrate
    .command('sort-index')
    .alias('sort_index')
    .description('Add sort_index values based on existing next-item ordering')
    .option('--dry-run', 'Preview changes without writing to the database')
    .option('--gap <gap>', `Gap between sort_index values (default: ${DEFAULT_SORT_GAP})`, String(DEFAULT_SORT_GAP))
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: MigrateOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const dryRun = Boolean(options.dryRun);
      const gap = parseInt(options.gap || String(DEFAULT_SORT_GAP), 10);

      if (Number.isNaN(gap) || gap <= 0) {
        output.error('Gap must be a positive integer', { success: false, error: 'Gap must be a positive integer' });
        process.exit(1);
      }

      if (dryRun) {
        const ordered = db.previewSortIndexOrder(gap);
        if (utils.isJsonMode()) {
          output.json({ success: true, dryRun: true, gap, count: ordered.length, items: ordered });
          return;
        }

        console.log(`Dry run: ${ordered.length} item(s) would be updated.`);
        ordered.forEach((entry: { id: string; title: string; sortIndex: number }) => {
          console.log(`${entry.id} ${entry.title} -> ${entry.sortIndex}`);
        });
        return;
      }

      const result = db.assignSortIndexValues(gap);
      if (utils.isJsonMode()) {
        output.json({ success: true, updated: result.updated, gap });
        return;
      }
      console.log(`Migration complete. Updated ${result.updated} item(s).`);
    });
}
