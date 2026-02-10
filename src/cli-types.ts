// Per-command CLI option interfaces for strong typing
import { WorkItemPriority, WorkItemStatus } from './types.js';

export interface InitOptions {
  projectName?: string;
  prefix?: string;
  autoExport?: string;
  autoSync?: string;
  agentsTemplate?: string;
  workflowInline?: string;
  statsPluginOverwrite?: string;
}

export interface StatusOptions { prefix?: string }

export interface CreateOptions {
  title: string;
  description?: string;
  descriptionFile?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  risk?: string;
  effort?: string;
  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;
  /** Accepts true|false|yes|no to set needsProducerReview flag for the new item */
  needsProducerReview?: string;
  prefix?: string;
}

export interface ListOptions {
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  /** 'true'|'false'|'yes'|'no' (string form from CLI); parsed to boolean by command */
  needsProducerReview?: string;
  prefix?: string;
  number?: string;
}

export interface ShowOptions { children?: boolean; prefix?: string }

export interface UpdateOptions {
  title?: string;
  description?: string;
  descriptionFile?: string;
  status?: WorkItemStatus;
  priority?: WorkItemPriority;
  parent?: string;
  tags?: string;
  assignee?: string;
  stage?: string;
  /** Accepts true|false|yes|no to set needsProducerReview flag */
  needsProducerReview?: string;
  risk?: string;
  effort?: string;
  issueType?: string;
  createdBy?: string;
  deletedBy?: string;
  deleteReason?: string;
  prefix?: string;
}

export interface ExportOptions { file?: string; prefix?: string }
export interface ImportOptions { file?: string; prefix?: string }

export interface NextOptions {
  assignee?: string;
  search?: string;
  number?: string;
  prefix?: string;
  includeInReview?: boolean;
}
export interface InProgressOptions { assignee?: string; prefix?: string }

export interface MigrateOptions {
  dryRun?: boolean;
  gap?: string;
  prefix?: string;
}

export interface ResortOptions {
  dryRun?: boolean;
  gap?: string;
  prefix?: string;
  recency?: string;
}

export interface SyncOptions {
  file?: string;
  prefix?: string;
  gitRemote?: string;
  gitBranch?: string;
  push?: boolean;
  dryRun?: boolean;
}

export interface SyncDebugOptions {
  file?: string;
  prefix?: string;
  gitRemote?: string;
  gitBranch?: string;
}

export interface CommentCreateOptions { author: string; comment?: string; body?: string; references?: string; prefix?: string }
export interface CommentListOptions { prefix?: string }
export interface CommentShowOptions { prefix?: string }
export interface CommentUpdateOptions { author?: string; comment?: string; references?: string; prefix?: string }
export interface CommentDeleteOptions { prefix?: string }

export interface RecentOptions { number?: string; children?: boolean; prefix?: string }
export interface CloseOptions { reason?: string; author?: string; prefix?: string }

export interface DeleteOptions { prefix?: string }

export interface DepOptions {
  prefix?: string;
  incoming?: boolean;
  outgoing?: boolean;
}
