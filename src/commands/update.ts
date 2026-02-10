/**
 * Update command - Update a work item
 */

import type { PluginContext } from '../plugin-types.js';
import type { UpdateOptions } from '../cli-types.js';
import type { UpdateWorkItemInput, WorkItemStatus, WorkItemPriority, WorkItemRiskLevel, WorkItemEffortLevel } from '../types.js';
import { promises as fs } from 'fs';
import { humanFormatWorkItem, resolveFormat } from './helpers.js';
import { canValidateStatusStage, validateStatusStageCompatibility, validateStatusStageInput } from './status-stage-validation.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  program
    .command('update <id>')
    .description('Update a work item')
    .option('-t, --title <title>', 'New title')
    .option('-d, --description <description>', 'New description')
    .option('--description-file <file>', 'Read description from a file')
    .option('-s, --status <status>', 'New status')
    .option('-p, --priority <priority>', 'New priority')
    .option('-P, --parent <parentId>', 'New parent ID')
    .option('--tags <tags>', 'New tags (comma-separated)')
    .option('-a, --assignee <assignee>', 'New assignee')
    .option('--stage <stage>', 'New stage')
    .option('--risk <risk>', 'New risk level (Low, Medium, High, Severe)')
    .option('--effort <effort>', 'New effort level (XS, S, M, L, XL)')
    .option('--issue-type <issueType>', 'New issue type (interoperability field)')
    .option('--created-by <createdBy>', 'New created by (interoperability field)')
    .option('--deleted-by <deletedBy>', 'New deleted by (interoperability field)')
    .option('--delete-reason <deleteReason>', 'New delete reason (interoperability field)')
    .option('--needs-producer-review <true|false>', 'Set needsProducerReview flag (true|false|yes|no)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action(async (id: string, options: UpdateOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedId = utils.normalizeCliId(id, options.prefix) || id;
      const updates: UpdateWorkItemInput = {};
      if (options.title) updates.title = options.title;
      if (options.description) updates.description = options.description;
      if (options.descriptionFile) {
        try {
          const contents = await fs.readFile(options.descriptionFile, 'utf8');
          updates.description = contents;
        } catch (err) {
          output.error(`Failed to read description file: ${options.descriptionFile}`);
          process.exit(1);
        }
      }
      const statusCandidate = options.status !== undefined ? options.status : undefined;
      if (options.priority) updates.priority = options.priority as WorkItemPriority;
      if (options.parent !== undefined) updates.parentId = utils.normalizeCliId(options.parent, options.prefix) || null;
      
      if (options.tags) updates.tags = options.tags.split(',').map((t: string) => t.trim());
      if (options.assignee !== undefined) updates.assignee = options.assignee;
      const stageCandidate = options.stage !== undefined ? options.stage : undefined;
      const config = utils.getConfig();
      if ((statusCandidate !== undefined || stageCandidate !== undefined) && canValidateStatusStage(config)) {
        const current = db.get(normalizedId);
        if (!current) {
          output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
          process.exit(1);
        }
        let normalizedStatus = current.status;
        let normalizedStage = current.stage;
        let warnings: string[] = [];
        try {
          const validation = validateStatusStageInput(
            {
              status: statusCandidate ?? current.status,
              stage: stageCandidate ?? current.stage,
            },
            config
          );
          normalizedStatus = validation.status as WorkItemStatus;
          normalizedStage = validation.stage;
          warnings = validation.warnings;
          validateStatusStageCompatibility(normalizedStatus, normalizedStage, validation.rules);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.error(message, { success: false, error: message });
          process.exit(1);
        }
        for (const warning of warnings) {
          console.error(warning);
        }
        if (statusCandidate !== undefined) updates.status = normalizedStatus as WorkItemStatus;
        if (stageCandidate !== undefined) updates.stage = normalizedStage;
      }
      if (options.risk !== undefined) updates.risk = options.risk as WorkItemRiskLevel | '';
      if (options.effort !== undefined) updates.effort = options.effort as WorkItemEffortLevel | '';
      if (options.issueType !== undefined) updates.issueType = options.issueType;
      if (options.createdBy !== undefined) updates.createdBy = options.createdBy;
      if (options.deletedBy !== undefined) updates.deletedBy = options.deletedBy;
      if (options.deleteReason !== undefined) updates.deleteReason = options.deleteReason;
      if (options.needsProducerReview !== undefined) {
        const raw = String(options.needsProducerReview).toLowerCase();
        const truthy = ['true', 'yes', '1'];
        const falsy = ['false', 'no', '0'];
        if (truthy.includes(raw)) updates.needsProducerReview = true;
        else if (falsy.includes(raw)) updates.needsProducerReview = false;
        else {
          output.error(`Invalid value for --needs-producer-review: ${options.needsProducerReview}`, { success: false, error: 'invalid-arg' });
          process.exit(1);
        }
      }
      
      const item = db.update(normalizedId, updates);
      if (!item) {
        output.error(`Work item not found: ${normalizedId}`, { success: false, error: `Work item not found: ${normalizedId}` });
        process.exit(1);
      }

      if (updates.status || updates.stage) {
        db.reconcileDependentStatus(normalizedId);
      }
      
      if (utils.isJsonMode()) {
        output.json({ success: true, workItem: item });
      } else {
        const format = resolveFormat(program);
        console.log('Updated work item:');
        console.log(humanFormatWorkItem(item, db, format));
      }
    });
}
