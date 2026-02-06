/**
 * Dependency commands - Manage dependency edges
 */

import chalk from 'chalk';
import type { PluginContext } from '../plugin-types.js';
import type { DepOptions } from '../cli-types.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  const depCommand = program
    .command('dep')
    .description('Manage dependency edges');

  depCommand
    .command('add <itemId> <dependsOnId>')
    .description('Add a dependency edge (item depends on dependsOn)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((itemId: string, dependsOnId: string, options: DepOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const normalizedDependsOnId = utils.normalizeCliId(dependsOnId, options.prefix) || dependsOnId;
      const itemIdLookup = normalizedItemId.toUpperCase();
      const dependsOnIdLookup = normalizedDependsOnId.toUpperCase();

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      const dependsOn = db.get(dependsOnIdLookup);
      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);
      if (!dependsOn) warnings.push(`Work item not found: ${normalizedDependsOnId}`);

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.error('One or more work items were not found', { success: false, errors: warnings });
        } else {
          warnings.forEach(w => console.error(chalk.red(`Error: ${w}`)));
        }
        process.exit(1);
      }

      const existing = db.listDependencyEdgesFrom(itemIdLookup).some(edge => edge.toId === dependsOnIdLookup);
      if (existing) {
        if (utils.isJsonMode()) {
          output.error('Dependency already exists.', { success: false, error: 'Dependency already exists.' });
        } else {
          console.error('Dependency already exists.');
        }
        process.exit(1);
      }

      const edge = db.addDependencyEdge(itemIdLookup, dependsOnIdLookup);
      if (dependsOn && !['in_review', 'done'].includes(dependsOn.stage)) {
        if (item && !['completed', 'deleted'].includes(item.status)) {
          db.update(itemIdLookup, { status: 'blocked' });
        }
      }
      if (utils.isJsonMode()) {
        output.json({ success: true, edge });
      } else {
        console.log(chalk.green('Successfully added dependency between'));
        const itemLabel = `${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`;
        const dependsOnLabel = `${dependsOn?.title || dependsOnIdLookup} ${chalk.gray(`(${dependsOnIdLookup})`)}`;
        console.log(`${itemLabel} ${chalk.green('which depends on')}`);
        console.log(`${dependsOnLabel}.`);
      }
    });

  depCommand
    .command('rm <itemId> <dependsOnId>')
    .description('Remove a dependency edge (item depends on dependsOn)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((itemId: string, dependsOnId: string, options: DepOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const normalizedDependsOnId = utils.normalizeCliId(dependsOnId, options.prefix) || dependsOnId;
      const itemIdLookup = normalizedItemId.toUpperCase();
      const dependsOnIdLookup = normalizedDependsOnId.toUpperCase();

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      const dependsOn = db.get(dependsOnIdLookup);
      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);
      if (!dependsOn) warnings.push(`Work item not found: ${normalizedDependsOnId}`);

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, warnings, removed: false, edge: null });
        } else {
          warnings.forEach(w => console.warn(`Warning: ${w}`));
        }
        return;
      }

      const removed = db.removeDependencyEdge(itemIdLookup, dependsOnIdLookup);
      if (utils.isJsonMode()) {
        output.json({ success: true, removed, edge: { fromId: itemIdLookup, toId: dependsOnIdLookup } });
      } else if (removed) {
        console.log(chalk.green('Successfully removed dependency between'));
        const itemLabel = `${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`;
        const dependsOnLabel = `${dependsOn?.title || dependsOnIdLookup} ${chalk.gray(`(${dependsOnIdLookup})`)}`;
        console.log(`${itemLabel} ${chalk.green('no longer depends on')}`);
        console.log(`${dependsOnLabel}.`);
      } else {
        console.log(`No dependency found: ${itemIdLookup} depends on ${dependsOnIdLookup}`);
      }

      if (removed && item && !['completed', 'deleted'].includes(item.status)) {
        const remaining = db.listDependencyEdgesFrom(itemIdLookup);
        const stillBlocked = remaining.some(edge => {
          const dep = db.get(edge.toId);
          return dep && !['in_review', 'done'].includes(dep.stage);
        });
        if (!stillBlocked) {
          db.update(itemIdLookup, { status: 'open' });
        }
      }
    });

  depCommand
    .command('list <itemId>')
    .description('List inbound and outbound dependency edges for a work item')
    .option('--prefix <prefix>', 'Override the default prefix')
    .option('--outgoing', 'Only show outbound dependencies')
    .option('--incoming', 'Only show inbound dependencies')
    .action((itemId: string, options: DepOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedItemId = utils.normalizeCliId(itemId, options.prefix) || itemId;
      const itemIdLookup = normalizedItemId.toUpperCase();

      if (options.incoming && options.outgoing) {
        const message = 'Cannot use --incoming and --outgoing together.';
        if (utils.isJsonMode()) {
          output.error(message, { success: false, error: message });
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
      }

      const warnings: string[] = [];
      const item = db.get(itemIdLookup);
      if (!item) warnings.push(`Work item not found: ${normalizedItemId}`);

      if (warnings.length > 0) {
        if (utils.isJsonMode()) {
          output.json({ success: true, warnings, inbound: [], outbound: [] });
        } else {
          warnings.forEach(w => console.warn(`Warning: ${w}`));
        }
        return;
      }

      const outboundEdges = options.incoming ? [] : db.listDependencyEdgesFrom(itemIdLookup);
      const inboundEdges = options.outgoing ? [] : db.listDependencyEdgesTo(itemIdLookup);

      const outbound = outboundEdges.map(edge => {
        const dep = db.get(edge.toId);
        return {
          id: edge.toId,
          title: dep?.title || '(missing)',
          status: dep?.status || 'deleted',
          priority: dep?.priority || 'medium',
          direction: 'depends-on',
        };
      });

      const inbound = inboundEdges.map(edge => {
        const dep = db.get(edge.fromId);
        return {
          id: edge.fromId,
          title: dep?.title || '(missing)',
          status: dep?.status || 'deleted',
          priority: dep?.priority || 'medium',
          direction: 'depended-on-by',
        };
      });

      if (utils.isJsonMode()) {
        output.json({ success: true, item: itemIdLookup, inbound, outbound });
        return;
      }

      console.log(`Dependencies for ${item?.title || itemIdLookup} ${chalk.gray(`(${itemIdLookup})`)}`);
      console.log('');
      if (!options.incoming) {
        console.log('Depends on:');
      }
      if (outbound.length === 0) {
        if (!options.incoming) {
          console.log('  (none)');
        }
      } else {
        outbound.forEach(dep => {
          const titleText = dep.status === 'completed'
            ? chalk.green(chalk.strikethrough(dep.title))
            : chalk.red(dep.title);
          console.log(`  - ${titleText} ${chalk.gray(`(${dep.id})`)} Status: ${dep.status} Priority: ${dep.priority} Direction: ${dep.direction}`);
        });
      }
      if (!options.incoming && !options.outgoing) {
        console.log('');
      }
      if (!options.outgoing) {
        console.log('Depended on by:');
      }
      if (inbound.length === 0) {
        if (!options.outgoing) {
          console.log('  (none)');
        }
      } else {
        inbound.forEach(dep => {
          console.log(`  - ${dep.title} ${chalk.gray(`(${dep.id})`)} Status: ${dep.status} Priority: ${dep.priority} Direction: ${dep.direction}`);
        });
      }
    });
}
