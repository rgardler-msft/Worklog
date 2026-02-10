/**
 * Doctor command - Validate work items against config rules
 */

import type { PluginContext } from '../plugin-types.js';
import { loadStatusStageRules } from '../status-stage-rules.js';
import { validateStatusStageItems } from '../doctor/status-stage-check.js';
import { validateDependencyEdges } from '../doctor/dependency-check.js';
import { listPendingMigrations, runMigrations } from '../migrations/index.js';

interface DoctorOptions {
  prefix?: string;
}

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;

  program
    .command('doctor')
    .description('Validate work items against status/stage config rules')
    .option('--fix', 'Apply safe fixes and prompt for non-safe findings')
    .option('--prefix <prefix>', 'Override the default prefix')
  .action(async (options: DoctorOptions & { fix?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const items = db.getAll();
      let rules;
      try {
        rules = loadStatusStageRules(utils.getConfig());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.error(message, { success: false, error: message });
        process.exit(1);
      }

      const dependencyEdges = db.getAllDependencyEdges();
      let findings = [
        ...validateStatusStageItems(items, rules),
        ...validateDependencyEdges(items, dependencyEdges),
      ];

      // If --fix was provided, attempt to apply safe fixes and prompt per non-safe finding
      if (options.fix) {
        // Lazy import to avoid adding readline overhead in normal runs
        const { applyDoctorFixes } = await import('../doctor/fix.js');
        // Import the Node readline module dynamically (avoid `require` which is not available in ESM runtime)
        const readlineMod = await import('node:readline');
        const promptFn = (promptText: string) => {
          const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
          return new Promise<boolean>(resolve => {
            rl.question(promptText + ' (y/N): ', (answer: string) => {
              rl.close();
              const a = (answer || '').trim().toLowerCase();
              resolve(a === 'y' || a === 'yes');
            });
          });
        };
        findings = await applyDoctorFixes(db, findings, promptFn);
      }

      // Support `doctor upgrade` as a convenience under doctor when --fix provided
      // (we only handle preview/confirm here via --fix && options.prefix)
      // Note: full CLI command is `wl doctor upgrade` but providing this here keeps doctor flow simple.
      // If user passed --upgrade we would trigger migrations. For now expose `WL_DO_UPGRADE` env for tests.
      const doUpgrade = process.env.WL_DO_UPGRADE === '1';
      if (doUpgrade) {
        try {
          const pending = listPendingMigrations();
          if (pending.length === 0) {
            console.log('No pending migrations.');
          } else {
            console.log('Pending migrations:');
            for (const p of pending) console.log(` - ${p.id}: ${p.description} (safe=${p.safe})`);
            const confirm = process.env.WL_DO_UPGRADE_CONFIRM === '1';
            if (confirm) {
              const result = runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } });
              console.log(`Applied migrations: ${result.applied.map(a => a.id).join(', ')}`);
              console.log(`Backups: ${result.backups.join(', ')}`);
            } else {
              console.log('Run with WL_DO_UPGRADE_CONFIRM=1 to apply.');
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Migration failed: ${message}`);
        }
      }

      if (utils.isJsonMode()) {
        output.json(findings);
        return;
      }

      if (findings.length === 0) {
        console.log('Doctor: no issues found.');
        return;
      }

      console.log('Doctor: validation findings');
      console.log('Rules source: docs/validation/status-stage-inventory.md');
      const byItem = new Map<string, typeof findings>();
      for (const finding of findings) {
        const existing = byItem.get(finding.itemId) || [];
        existing.push(finding);
        byItem.set(finding.itemId, existing);
      }

      for (const [itemId, itemFindings] of byItem.entries()) {
        console.log(`\n${itemId}`);
        for (const finding of itemFindings) {
          console.log(`  - ${finding.message}`);
          if (finding.proposedFix) {
            console.log(`    Suggested: ${JSON.stringify(finding.proposedFix)}`);
          }
        }
      }

      // At the end, list findings that require manual intervention (no actionable proposedFix)
      const manual = findings.filter(f => {
        const ctx = (f as any).context || {};
        const proposed = f.proposedFix as any;
        const hasActionableFix = proposed && typeof proposed === 'object' && (
          Object.prototype.hasOwnProperty.call(proposed, 'status') ||
          Object.prototype.hasOwnProperty.call(proposed, 'stage')
        );
        return !!ctx.requiresManualFix || !hasActionableFix;
      });
      if (manual.length > 0) {
        // Group by finding type
        const byType = new Map<string, typeof manual>();
        for (const f of manual) {
          const list = byType.get(f.type) || [];
          list.push(f);
          byType.set(f.type, list);
        }

        console.log('\nManual fixes required (grouped by type):');
        for (const [type, group] of byType.entries()) {
          console.log(`\nType: ${type}`);
          for (const f of group) {
            // Show basic message
            let line = `  - ${f.itemId}: ${f.message}`;
            // Include suggested allowed values if available
            const proposed = f.proposedFix as any;
            const ctx = (f as any).context || {};
            const suggestions: string[] = [];
            if (proposed) {
              if (proposed.allowedStages) suggestions.push(`allowedStages=${JSON.stringify(proposed.allowedStages)}`);
              if (proposed.allowedStatuses) suggestions.push(`allowedStatuses=${JSON.stringify(proposed.allowedStatuses)}`);
              if (proposed.stage) suggestions.push(`proposedStage=${String(proposed.stage)}`);
              if (proposed.status) suggestions.push(`proposedStatus=${String(proposed.status)}`);
            }
            // Also check context for same keys
            if (ctx.allowedStages && !suggestions.some(s => s.startsWith('allowedStages='))) {
              suggestions.push(`allowedStages=${JSON.stringify(ctx.allowedStages)}`);
            }
            if (ctx.allowedStatuses && !suggestions.some(s => s.startsWith('allowedStatuses='))) {
              suggestions.push(`allowedStatuses=${JSON.stringify(ctx.allowedStatuses)}`);
            }

            if (suggestions.length > 0) line += ` (${suggestions.join('; ')})`;
            console.log(line);
          }
        }
      }
    });
}
