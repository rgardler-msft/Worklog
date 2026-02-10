/**
 * List command - List work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { ListOptions } from '../cli-types.js';
import type { WorkItemQuery, WorkItemStatus, WorkItemPriority } from '../types.js';
import { displayItemTree, displayItemTreeWithFormat, humanFormatWorkItem, resolveFormat, sortByPriorityAndDate } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('list')
    .description('List work items')
    .argument('[search]', 'Search term (matches id, title, and description)')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --priority <priority>', 'Filter by priority')
    .option('--parent <id>', 'Filter by parent id (direct children only)')
    
    .option('-n, --number <n>', 'Limit the number of items returned')
    .option('--tags <tags>', 'Filter by tags (comma-separated)')
    .option('-a, --assignee <assignee>', 'Filter by assignee')
    .option('--stage <stage>', 'Filter by stage')
    .option('--needs-producer-review <true|false>', 'Filter by needsProducerReview flag (true|false)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((search: string | undefined, options: ListOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options?.prefix);
      
      const query: WorkItemQuery = {};
      if (options.status) query.status = options.status as WorkItemStatus;
      if (options.priority) query.priority = options.priority as WorkItemPriority;
      if (options.parent) {
        const normalizedParentId = utils.normalizeCliId(options.parent, options.prefix) || options.parent;
        const parent = db.get(normalizedParentId);
        if (!parent) {
          output.error(`Work item not found: ${normalizedParentId}`, { success: false, error: `Work item not found: ${normalizedParentId}` });
          process.exit(1);
        }
        query.parentId = normalizedParentId;
      }
      
      if (options.tags) {
        query.tags = options.tags.split(',').map((t: string) => t.trim());
      }
      if (options.assignee) query.assignee = options.assignee;
      if (options.stage) query.stage = options.stage;
      if (options.needsProducerReview !== undefined) {
        // Accept common boolean-like CLI values
        const raw = String(options.needsProducerReview).toLowerCase();
        const truthy = ['true', 'yes', '1'];
        const falsy = ['false', 'no', '0'];
        if (truthy.includes(raw)) query.needsProducerReview = true;
        else if (falsy.includes(raw)) query.needsProducerReview = false;
        else {
          output.error(`Invalid value for --needs-producer-review: ${options.needsProducerReview}`, { success: false, error: 'invalid-arg' });
          process.exit(1);
        }
      }
      
      let items = db.list(query);

      // Apply --number/-n limit when provided (only for human or JSON output)
      const numRequested = options.number ? parseInt(options.number as any, 10) : NaN;
      const limit = Number.isNaN(numRequested) || numRequested < 1 ? undefined : numRequested;

      // By default hide completed items for human-readable output only.
      // When JSON mode is requested return all matching items so callers
      // can decide how to handle completed items programmatically.
      if (!options.status && !utils.isJsonMode()) {
        items = items.filter(item => item.status !== 'completed');
      }

      if (search) {
        const lower = String(search).toLowerCase();
        items = items.filter(item => {
          const idMatch = item.id && item.id.toLowerCase().includes(lower);
          const titleMatch = item.title && item.title.toLowerCase().includes(lower);
          const descMatch = item.description && item.description.toLowerCase().includes(lower);
          return Boolean(idMatch || titleMatch || descMatch);
        });
      }
      
      // Sort then apply limit so we return the intended order
      const allowedIds = new Set(items.map(item => item.id));
      const orderedItems = db.getAllOrderedByHierarchySortIndex().filter(item => allowedIds.has(item.id));
      const positions = new Map(orderedItems.map((item, index) => [item.id, index]));
      const sortedAll = items.slice().sort((a, b) => {
        const aPos = positions.get(a.id);
        const bPos = positions.get(b.id);
        if (aPos === undefined && bPos === undefined) {
          return sortByPriorityAndDate(a, b);
        }
        if (aPos === undefined) return 1;
        if (bPos === undefined) return -1;
        if (aPos !== bPos) return aPos - bPos;
        return sortByPriorityAndDate(a, b);
      });
      const limited = limit ? sortedAll.slice(0, limit) : sortedAll;

      if (utils.isJsonMode()) {
        output.json({ success: true, count: limited.length, workItems: limited });
      } else {
        if (items.length === 0) {
          console.log('No work items found');
          return;
        }

        const displayItems = limited;
        console.log(`Found ${displayItems.length} work item(s):\n`);
        const format = resolveFormat(program);
        if (format.toLowerCase() === 'concise') {
          console.log('');
          // Use the shared renderer so `list` and `show` produce identical concise output.
          // The human formatter's concise mode now includes the additional fields
          // (Status, Priority, Risk, Effort, Assignee, Tags) so this preserves
          // the richer information previously shown by the legacy tree printer.
          displayItemTreeWithFormat(displayItems, db, format);
          console.log('');
          return;
        }

        const sortedItems = displayItems;
        console.log('');
        sortedItems.forEach((item, index) => {
          console.log(humanFormatWorkItem(item, null, format));
          if (index < sortedItems.length - 1) console.log('');
        });
        console.log('');
      }
    });
}
