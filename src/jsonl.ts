/**
 * JSONL (JSON Lines) import/export functionality
 * This format is Git-friendly as each work item is on a separate line
 */

import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, Comment, DependencyEdge, WorkItemDependency } from './types.js';
import { stripWorklogMarkers } from './github.js';
import { resolveWorklogDir } from './worklog-paths.js';

function normalizeForStableJson(value: any): any {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => normalizeForStableJson(v));
  if (typeof value !== 'object') return value;

  const out: any = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeForStableJson(value[key]);
  }
  return out;
}

function stableStringify(value: any): string {
  return JSON.stringify(normalizeForStableJson(value));
}

interface JsonlRecord {
  type: 'workitem' | 'comment';
  data: WorkItem | Comment;
}

function normalizeDependencies(input: WorkItemDependency[] | undefined): WorkItemDependency[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string')
    .map(edge => ({ from: edge.from, to: edge.to }));
}

export function dependenciesFromEdges(edges: DependencyEdge[], itemId: string): WorkItemDependency[] {
  return edges
    .filter(edge => edge.fromId === itemId)
    .map(edge => ({ from: edge.fromId, to: edge.toId }))
    .sort((a, b) => {
      const fromDiff = a.from.localeCompare(b.from);
      if (fromDiff !== 0) return fromDiff;
      return a.to.localeCompare(b.to);
    });
}

function mergeDependencyEdges(edges: DependencyEdge[]): DependencyEdge[] {
  const merged = new Map<string, DependencyEdge>();
  for (const edge of edges) {
    merged.set(`${edge.fromId}::${edge.toId}`, edge);
  }
  return Array.from(merged.values());
}


/**
 * Export work items and comments to a JSONL file
 */
export function exportToJsonl(
  items: WorkItem[],
  comments: Comment[],
  filepath: string,
  dependencyEdges: DependencyEdge[] = []
): number {
  const lines: string[] = [];

  const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const normalizedEdges = mergeDependencyEdges(dependencyEdges);
  const sortedComments = [...comments].sort((a, b) => {
    const wi = a.workItemId.localeCompare(b.workItemId);
    if (wi !== 0) return wi;
    const ca = a.createdAt.localeCompare(b.createdAt);
    if (ca !== 0) return ca;
    return a.id.localeCompare(b.id);
  });
  
  // Add work items
  sortedItems.forEach(item => {
    const dependencies = dependenciesFromEdges(normalizedEdges, item.id);
    const itemWithDeps: WorkItem = {
      ...item,
      dependencies: dependencies.length > 0 ? dependencies : [],
    };
    lines.push(stableStringify({ type: 'workitem', data: itemWithDeps }));
  });
  
  // Add comments
  sortedComments.forEach(comment => {
    // Ensure comment includes the new optional GitHub mapping fields when present
    const outComment = { ...comment } as any;
    if (outComment.githubCommentId === undefined) delete outComment.githubCommentId;
    if (outComment.githubCommentUpdatedAt === undefined) delete outComment.githubCommentUpdatedAt;
    lines.push(stableStringify({ type: 'comment', data: outComment }));
  });
  
  // Ensure directory exists
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to a temporary file in the same directory then rename
  // to avoid other processes reading a partially-written file.
  const content = lines.join('\n') + '\n';
  const tempName = `${path.basename(filepath)}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  const tempPath = path.join(dir, tempName);

  fs.writeFileSync(tempPath, content, 'utf-8');
  // Rename is atomic on most POSIX filesystems when performed within same fs/dir
  fs.renameSync(tempPath, filepath);

  const stats = fs.statSync(filepath);
  return stats.mtimeMs;
}

/**
 * Import work items and comments from a JSONL file
 */
export function importFromJsonl(filepath: string): { items: WorkItem[], comments: Comment[], dependencyEdges: DependencyEdge[] } {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }

  const content = fs.readFileSync(filepath, 'utf-8');
  return importFromJsonlContent(content);
}

export function importFromJsonlContent(content: string): { items: WorkItem[], comments: Comment[], dependencyEdges: DependencyEdge[] } {
  const lines = content.split('\n').filter(line => line.trim() !== '');
  
  const items: WorkItem[] = [];
  const comments: Comment[] = [];
  const dependencyEdges: DependencyEdge[] = [];
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      
      // Handle new format with type field
      if (parsed.type === 'workitem' && parsed.data) {
        const item = parsed.data as WorkItem;
        const dependencies = normalizeDependencies(item.dependencies);
        // Ensure backward compatibility
        if (item.assignee === undefined) {
          item.assignee = '';
        }
        if (item.stage === undefined) {
          item.stage = '';
        }
        if ((item as any).issueType === undefined) {
          (item as any).issueType = '';
        }
        if ((item as any).createdBy === undefined) {
          (item as any).createdBy = '';
        }
        if ((item as any).deletedBy === undefined) {
          (item as any).deletedBy = '';
        }
        if ((item as any).deleteReason === undefined) {
          (item as any).deleteReason = '';
        }
        if ((item as any).sortIndex === undefined) {
          (item as any).sortIndex = 0;
        }
        if ((item as any).risk === undefined) {
          (item as any).risk = '';
        }
        if ((item as any).effort === undefined) {
          (item as any).effort = '';
        }
        if ((item as any).githubIssueNumber === undefined) {
          (item as any).githubIssueNumber = undefined;
        }
        if ((item as any).githubIssueId === undefined) {
          (item as any).githubIssueId = undefined;
        }
        if ((item as any).githubIssueUpdatedAt === undefined) {
          (item as any).githubIssueUpdatedAt = undefined;
        }
      if ((item as any).githubIssueNumber !== undefined && (item as any).githubIssueNumber !== null) {
          (item as any).githubIssueNumber = Number((item as any).githubIssueNumber);
        }
        if ((item as any).githubIssueId !== undefined && (item as any).githubIssueId !== null) {
          (item as any).githubIssueId = Number((item as any).githubIssueId);
        }
        if (item.description) {
          item.description = stripWorklogMarkers(item.description);
        }
        // Preserve presence/absence of the new boolean field so round-trip
        // export/import does not introduce properties that weren't in the source.
        if ((item as any).needsProducerReview !== undefined) {
          (item as any).needsProducerReview = Boolean((item as any).needsProducerReview);
        }
        item.dependencies = dependencies;
        items.push(item);
        for (const dep of dependencies) {
          dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
        }
      } else if (parsed.type === 'comment' && parsed.data) {
        const comment = parsed.data as Comment;
        if (comment.comment) {
          comment.comment = stripWorklogMarkers(comment.comment);
        }
        // Preserve optional GitHub mapping fields when present in JSONL
        const normalized: any = { ...comment };
        if (normalized.githubCommentId === undefined) normalized.githubCommentId = undefined;
        if (normalized.githubCommentUpdatedAt === undefined) normalized.githubCommentUpdatedAt = undefined;
        comments.push(normalized as Comment);
      } else {
        // Handle old format (no type field) - assume it's a work item
        console.warn(`Warning: Found entry without type field, assuming it's a work item. Consider migrating to the new format.`);
        const item = parsed as WorkItem;
        const dependencies = normalizeDependencies(item.dependencies);
        if (item.assignee === undefined) {
          item.assignee = '';
        }
        if (item.stage === undefined) {
          item.stage = '';
        }
        if ((item as any).issueType === undefined) {
          (item as any).issueType = '';
        }
        if ((item as any).createdBy === undefined) {
          (item as any).createdBy = '';
        }
        if ((item as any).deletedBy === undefined) {
          (item as any).deletedBy = '';
        }
        if ((item as any).deleteReason === undefined) {
          (item as any).deleteReason = '';
        }
        if ((item as any).sortIndex === undefined) {
          (item as any).sortIndex = 0;
        }
        if ((item as any).risk === undefined) {
          (item as any).risk = '';
        }
        if ((item as any).effort === undefined) {
          (item as any).effort = '';
        }
        if ((item as any).githubIssueNumber === undefined) {
          (item as any).githubIssueNumber = undefined;
        }
        if ((item as any).githubIssueId === undefined) {
          (item as any).githubIssueId = undefined;
        }
        if ((item as any).githubIssueUpdatedAt === undefined) {
          (item as any).githubIssueUpdatedAt = undefined;
        }
        if ((item as any).githubIssueNumber !== undefined && (item as any).githubIssueNumber !== null) {
          (item as any).githubIssueNumber = Number((item as any).githubIssueNumber);
        }
        if ((item as any).githubIssueId !== undefined && (item as any).githubIssueId !== null) {
          (item as any).githubIssueId = Number((item as any).githubIssueId);
        }
        if (item.description) {
          item.description = stripWorklogMarkers(item.description);
        }
        item.dependencies = dependencies;
        items.push(item);
        for (const dep of dependencies) {
          dependencyEdges.push({ fromId: dep.from, toId: dep.to, createdAt: new Date().toISOString() });
        }
      }
    } catch (error) {
      console.error(`Error parsing line: ${line}`);
      throw error;
    }
  }
  
  return { items, comments, dependencyEdges };
}

/**
 * Get the default data file path
 */
export function getDefaultDataPath(): string {
  return path.join(resolveWorklogDir(), 'worklog-data.jsonl');
}
