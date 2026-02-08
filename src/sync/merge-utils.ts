import { WorkItem } from '../types.js';
import type { MergeOptions } from '../sync.js';

/**
 * Check if a value appears to be a default/empty value
 */
export function isDefaultValue(value: unknown, field: string, options?: MergeOptions): boolean {
  if (options?.defaultValueFields?.includes(field as keyof WorkItem)) {
    return false;
  }
  if (value === null || value === undefined || value === '') {
    return true;
  }
  if (Array.isArray(value) && value.length === 0) {
    return true;
  }
  // Only treat truly empty/undefined values as defaults. Do NOT assume
  // that common values like 'open' or 'medium' imply the user didn't set
  // them intentionally — any defined value is considered a real value.
  // Treat empty strings as default for these metadata fields
  if ((field === 'issueType' || field === 'createdBy' || field === 'deletedBy' || field === 'deleteReason') && value === '') {
    return true;
  }
  return false;
}

export function stableValueKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  if (Array.isArray(value)) {
    return `a:${JSON.stringify([...value].map(v => String(v)).sort())}`;
  }
  return `v:${JSON.stringify(value)}`;
}

export function stableItemKey(item: WorkItem): string {
  // Keep this stable across instances even if property insertion order differs.
  // Tags are compared as a set.
  const normalized: WorkItem = {
    ...item,
    tags: [...(item.tags || [])].slice().sort(),
  };
  const keys = Object.keys(normalized)
    .filter(key => key !== 'dependencies')
    .sort();
  return JSON.stringify(normalized, keys);
}

export function mergeTags(a: string[] | undefined, b: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const t of a || []) out.add(String(t));
  for (const t of b || []) out.add(String(t));
  return Array.from(out).sort();
}
