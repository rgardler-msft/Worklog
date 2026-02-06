/**
 * In-progress command - List all in-progress work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { InProgressOptions } from '../cli-types.js';
import type { WorkItemQuery, WorkItemStatus } from '../types.js';
import { displayItemTree, humanFormatWorkItem, resolveFormat, sortByPriorityAndDate } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('in-progress')
    .alias('in_progress')
    .description('List all in-progress work items in a tree layout showing hierarchy')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: InProgressOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const query: WorkItemQuery = { status: 'in-progress' as WorkItemStatus };
      if (options.assignee) {
        query.assignee = options.assignee;
      }
      const items = db.list(query);
      
      if (utils.isJsonMode()) {
        output.json({ success: true, count: items.length, workItems: items });
      } else {
        if (items.length === 0) {
          console.log('No in-progress work items found');
          return;
        }
        
        console.log(`\nFound ${items.length} in-progress work item(s):\n`);
        const format = resolveFormat(program);
        if (format.toLowerCase() === 'concise') {
          displayItemTree(items);
          console.log();
          return;
        }

        const sortedItems = items.slice().sort(sortByPriorityAndDate);
        sortedItems.forEach((item, index) => {
          console.log(humanFormatWorkItem(item, null, format));
          if (index < sortedItems.length - 1) console.log('');
        });
        console.log();
      }
    });
}
