/**
 * Next command - Find the next work item to work on
 */

import type { PluginContext } from '../plugin-types.js';
import type { NextOptions } from '../cli-types.js';
import { humanFormatWorkItem, resolveFormat, formatTitleAndId } from './helpers.js';
import chalk from 'chalk';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('next')
    .description('Find the next work item to work on based on priority and status')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('-s, --search <term>', 'Search term for fuzzy matching against title, description, and comments')
    .option('-n, --number <n>', 'Number of items to return (default: 1)', '1')
    .option('--recency-policy <policy>', 'Recency policy: prefer|avoid|ignore (default: ignore)', 'ignore')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--include-in-review', 'Include items with status blocked and stage in_review (default: excluded)')
    .action(async (options: any) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
       const numRequested = parseInt(options.number || '1', 10);
      const count = Number.isNaN(numRequested) || numRequested < 1 ? 1 : numRequested;

      const recencyPolicy = options.recencyPolicy || 'ignore';

      // `findNextWorkItems` and `findNextWorkItem` gained an optional recencyPolicy
      const includeInReview = Boolean(options.includeInReview);

      const results = (db as any).findNextWorkItems 
        ? (db as any).findNextWorkItems(count, options.assignee, options.search, recencyPolicy, includeInReview) 
        : [db.findNextWorkItem(options.assignee, options.search, recencyPolicy, includeInReview)];

      if (utils.isJsonMode()) {
        if (results.length === 1) {
          const single = results[0];
          output.json({ success: true, workItem: single.workItem, reason: single.reason });
          return;
        }

        output.json({ success: true, count: results.length, results });
        return;
      }

      if (!results || results.length === 0) {
        console.log('No work items found to work on.');
        return;
      }

      const chosenFormat = resolveFormat(program);
      if (results.length === 1) {
        const result = results[0];
        if (!result.workItem) {
          console.log('No work items found to work on.');
          if (result.reason) console.log(`Reason: ${result.reason}`);
          return;
        }

        console.log('');
        const reasonText = result.reason.replace(/\b[A-Z]+-[A-Z0-9]+\b/g, (match: string) => {
          const referenced = db.get(match);
          return referenced ? `"${referenced.title}" (${match})` : match;
        });
        console.log(humanFormatWorkItem(result.workItem, db, chosenFormat));
        console.log(`\n${chalk.gray('## Reason for Selection')}`);
        console.log(chalk.gray(reasonText));
        console.log('');
        console.log(`${chalk.gray('ID')}: ${chalk.gray(result.workItem.id)}`);
        return;
      }

      console.log(`\nNext ${results.length} work item(s) to work on:`);
      console.log('===============================\n');
      results.forEach((res: any, idx: number) => {
        if (!res.workItem) {
          console.log(`${idx + 1}. (no item) - ${res.reason}`);
          return;
        }
        if (chosenFormat === 'concise') {
          console.log(`${idx + 1}. ${formatTitleAndId(res.workItem)}`);
          // Display stage even when it's an empty string (map to 'Undefined').
          const _stage = (res.workItem.stage as string | undefined);
          const stageLabel = _stage === undefined ? undefined : (_stage === '' ? 'Undefined' : _stage);
          if (stageLabel !== undefined) {
            console.log(`   Status: ${res.workItem.status} · Stage: ${stageLabel} | Priority: ${res.workItem.priority}`);
          } else {
            console.log(`   Status: ${res.workItem.status} | Priority: ${res.workItem.priority}`);
          }
          if (res.workItem.assignee) console.log(`   Assignee: ${res.workItem.assignee}`);
          if (res.workItem.parentId) console.log(`   Parent: ${res.workItem.parentId}`);
          if (res.workItem.description) console.log(`   ${res.workItem.description}`);
          console.log(`   Reason: ${chalk.cyan(res.reason)}`);
          console.log('');
        } else {
          console.log(`${idx + 1}.`);
          console.log(humanFormatWorkItem(res.workItem, db, chosenFormat));
          console.log(`Reason: ${chalk.cyan(res.reason)}`);
          console.log('');
        }
      });
    });
}
