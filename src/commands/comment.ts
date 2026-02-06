/**
 * Comment commands - Manage comments on work items
 */

import type { PluginContext } from '../plugin-types.js';
import type { 
  CommentCreateOptions, 
  CommentListOptions, 
  CommentShowOptions, 
  CommentUpdateOptions, 
  CommentDeleteOptions 
} from '../cli-types.js';
import type { UpdateCommentInput } from '../types.js';
import { humanFormatComment, resolveFormat } from './helpers.js';

export default function register(ctx: PluginContext): void {
  const { program, output, utils } = ctx;
  
  const commentCommand = program
    .command('comment')
    .description('Manage comments on work items');

  commentCommand
    .command('create <workItemId>')
    .alias('add')
    .description('Create a comment on a work item')
    .requiredOption('-a, --author <author>', 'Author of the comment')
    .option('-c, --comment <comment>', 'Comment text (markdown supported)')
    .option('--body <body>', 'Comment text (markdown supported) — alias for --comment')
    .option('-r, --references <references>', 'Comma-separated list of references (work item IDs, file paths, or URLs)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((workItemId: string, options: CommentCreateOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedWorkItemId = utils.normalizeCliId(workItemId, options.prefix) || workItemId;
      const refs = options.references ? options.references.split(',').map((r: string) => {
        const t = r.trim();
        // If looks like an unprefixed ID (alphanumeric only) or contains a dash, normalize
        if (/^[A-Z0-9]+$/i.test(t) || /^[A-Z0-9]+-[A-Z0-9]+$/i.test(t)) {
          return utils.normalizeCliId(t, options.prefix) || t;
        }
        return t;
      }) : [];

      // Support either --comment (legacy) or --body (new alias).
      // Error if both provided.
      if (options.comment && options.body) {
        output.error('Cannot use both --comment and --body together.', { success: false, error: 'Cannot use both --comment and --body together.' });
        process.exit(1);
      }

      const commentText = options.comment ?? options.body;
      if (!commentText || commentText.trim() === '') {
        output.error('Missing comment text. Provide --comment or --body with the comment text.', { success: false, error: 'Missing comment text. Provide --comment or --body with the comment text.' });
        process.exit(1);
      }

      const comment = db.createComment({
        workItemId: normalizedWorkItemId,
        author: options.author,
        comment: commentText,
        references: refs,
      });
      
      if (!comment) {
        output.error(`Work item not found: ${workItemId}`, { success: false, error: `Work item not found: ${workItemId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        output.json({ success: true, comment });
      } else {
        const format = resolveFormat(program);
        console.log('Created comment:');
        console.log(humanFormatComment(comment, format));
      }
    });

  commentCommand
    .command('list <workItemId>')
    .description('List all comments for a work item')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((workItemId: string, options: CommentListOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedWorkItemId = utils.normalizeCliId(workItemId, options.prefix) || workItemId;
      const workItem = db.get(normalizedWorkItemId);
      if (!workItem) {
        output.error(`Work item not found: ${normalizedWorkItemId}`, { success: false, error: `Work item not found: ${normalizedWorkItemId}` });
        process.exit(1);
      }
      
      // Use the normalized work item id when fetching comments so prefixed and
      // unprefixed ids behave consistently.
      const comments = db.getCommentsForWorkItem(normalizedWorkItemId);
      
        if (utils.isJsonMode()) {
          output.json({ success: true, count: comments.length, workItemId: normalizedWorkItemId, comments });
        } else {
          if (comments.length === 0) {
            console.log('No comments found for this work item');
            return;
          }
          
          console.log(`Found ${comments.length} comment(s) for ${normalizedWorkItemId}:\n`);
          comments.forEach(comment => {
            console.log(`[${comment.id}] by ${comment.author} at ${comment.createdAt}`);
            console.log(`  ${comment.comment}`);
          if (comment.references.length > 0) {
            console.log(`  References: ${comment.references.join(', ')}`);
          }
          console.log();
        });
      }
    });

  commentCommand
    .command('show <commentId>')
    .description('Show details of a comment')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((commentId: string, options: CommentShowOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedCommentId = utils.normalizeCliId(commentId, options.prefix) || commentId;
      const comment = db.getComment(normalizedCommentId);
      if (!comment) {
        output.error(`Comment not found: ${normalizedCommentId}`, { success: false, error: `Comment not found: ${normalizedCommentId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        output.json({ success: true, comment });
      } else {
        const format = resolveFormat(program);
        console.log(humanFormatComment(comment, format));
      }
    });

  commentCommand
    .command('update <commentId>')
    .description('Update a comment')
    .option('-a, --author <author>', 'New author')
    .option('-c, --comment <comment>', 'New comment text')
    .option('-r, --references <references>', 'New references (comma-separated)')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((commentId: string, options: CommentUpdateOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      
      const updates: UpdateCommentInput = {};
      if (options.author) updates.author = options.author;
      if (options.comment) updates.comment = options.comment;
      if (options.references) updates.references = options.references.split(',').map((r: string) => {
        const t = r.trim();
        if (/^[A-Z0-9]+$/i.test(t) || /^[A-Z0-9]+-[A-Z0-9]+$/i.test(t)) {
          return utils.normalizeCliId(t, options.prefix) || t;
        }
        return t;
      });
      
      const normalizedCommentId = utils.normalizeCliId(commentId, options.prefix) || commentId;
      const comment = db.updateComment(normalizedCommentId, updates);
      if (!comment) {
        output.error(`Comment not found: ${normalizedCommentId}`, { success: false, error: `Comment not found: ${normalizedCommentId}` });
        process.exit(1);
      }
      
      if (utils.isJsonMode()) {
        output.json({ success: true, comment });
      } else {
        const format = resolveFormat(program);
        console.log('Updated comment:');
        console.log(humanFormatComment(comment, format));
      }
    });

  commentCommand
    .command('delete <commentId>')
    .description('Delete a comment')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((commentId: string, options: CommentDeleteOptions) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const normalizedCommentId = utils.normalizeCliId(commentId, options.prefix) || commentId;
      const deleted = db.deleteComment(normalizedCommentId);
      if (!deleted) {
        output.error(`Comment not found: ${normalizedCommentId}`, { success: false, error: `Comment not found: ${normalizedCommentId}` });
        process.exit(1);
      }
      
        if (utils.isJsonMode()) {
        output.json({ success: true, message: `Deleted comment: ${normalizedCommentId}`, deletedId: normalizedCommentId });
      } else {
        console.log(`Deleted comment: ${normalizedCommentId}`);
      }
    });
}
