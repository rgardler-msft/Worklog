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

  const doctor = program
    .command('doctor')
    .description('Validate work items against status/stage config rules')
    .option('--fix', 'Apply safe fixes and prompt for non-safe findings')
    .option('--prefix <prefix>', 'Override the default prefix');

  doctor
    .command('upgrade')
    .description('Preview or apply pending database schema migrations')
    .option('--dry-run', 'Preview pending migrations without applying them')
    .option('--confirm', 'Apply pending migrations (non-interactive)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (opts: { dryRun?: boolean; confirm?: boolean; prefix?: string }) => {
      // Migration upgrade subcommand
      utils.requireInitialized();
      try {
        const pending = listPendingMigrations();
        if (!pending || pending.length === 0) {
          if (utils.isJsonMode()) {
            output.json({ success: true, pending: [] });
            return;
          }
          console.log('Doctor: no pending migrations. See docs/migrations.md for migration policy and guidance.');
          return;
        }

        if (opts.dryRun) {
          if (utils.isJsonMode()) {
            output.json({ success: true, dryRun: true, pending });
            return;
          }
          // Dry-run: list all pending migrations (no prompt, purely informational)
          console.log('Pending migrations:');
          pending.forEach(p => console.log(` - ${p.id}: ${p.description} (safe=${p.safe})`));
          return;
        }

        // Not a dry-run: list safe migrations, print blank line, and ask to apply
        const safeMigs = pending.filter(p => p.safe);
        if (utils.isJsonMode()) {
          output.json({ success: true, pending, safeMigrations: safeMigs });
          return;
        }
        console.log('Pending safe migrations:');
        safeMigs.forEach(p => console.log(` - ${p.id}: ${p.description}`));
        console.log('');

        // Confirm before applying unless --confirm provided
        let proceed = Boolean(opts.confirm);
        if (!proceed) {
          // Prompt interactively
          const readlineMod = await import('node:readline');
          const answer = await new Promise<boolean>(resolve => {
            const rl = readlineMod.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Apply ${pending.length} pending migration(s)? (y/N): `, (a: string) => {
              rl.close();
              const v = (a || '').trim().toLowerCase();
              resolve(v === 'y' || v === 'yes');
            });
          });
          proceed = answer;
        }

        if (!proceed) {
          if (utils.isJsonMode()) output.json({ success: false, message: 'User declined to apply migrations' });
          else console.log('Aborted: migrations not applied.');
          return;
        }

        // Apply migrations
        try {
          const result = runMigrations({ dryRun: false, confirm: true, logger: { info: s => console.error(s), error: s => console.error(s) } });
          if (utils.isJsonMode()) {
            output.json({ success: true, applied: result.applied, backups: result.backups });
            return;
          }
          console.log(`Applied migrations: ${result.applied.map(a => a.id).join(', ')}`);
          if (result.backups && result.backups.length > 0) console.log(`Backups: ${result.backups.join(', ')}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (utils.isJsonMode()) output.json({ success: false, error: message });
          else console.error(`Migration failed: ${message}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (utils.isJsonMode()) output.json({ success: false, error: message });
        else console.error(`Doctor upgrade failed: ${message}`);
      }
    });

  doctor.action(async (options: DoctorOptions & { fix?: boolean }) => {
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

      // Human-readable output handled below

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
