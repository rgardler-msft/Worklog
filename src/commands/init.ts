/**
 * Init command - Initialize worklog configuration
 */

import type { PluginContext } from '../plugin-types.js';
import type { InitOptions } from '../cli-types.js';
import type { DependencyEdge } from '../types.js';
import { initConfig, loadConfig, configExists, isInitialized, readInitSemaphore, writeInitSemaphore, type InitConfigOptions } from '../config.js';
import { resolveWorklogDir } from '../worklog-paths.js';
import { exportToJsonl } from '../jsonl.js';
import { getRemoteDataFileContent, gitPushDataFileToBranch, mergeWorkItems, mergeComments, mergeDependencyEdges } from '../sync.js';
import { DEFAULT_GIT_REMOTE, DEFAULT_GIT_BRANCH } from '../sync-defaults.js';
import { importFromJsonlContent } from '../jsonl.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const WORKLOG_PRE_PUSH_HOOK_MARKER = 'worklog:pre-push-hook:v1';
const WORKLOG_POST_PULL_HOOK_MARKER = 'worklog:post-pull-hook:v1';
const WORKLOG_POST_CHECKOUT_HOOK_MARKER = 'worklog:post-checkout-hook:v1';
const WORKLOG_GITIGNORE_SECTION_START = 'Worklog Specific Ignores';
const WORKLOG_GITIGNORE_SECTION_END = '### End of Worklog Specific Ignores';
const WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH = 'templates/AGENTS.md';
const WORKLOG_AGENT_DESTINATION_FILENAME = 'AGENTS.md';
const WORKFLOW_TEMPLATE_RELATIVE_PATH = 'templates/WORKFLOW.md';
const WORKFLOW_DESTINATION_FILENAME = 'WORKFLOW.md';
const WORKLOG_GITIGNORE_TEMPLATE_RELATIVE_PATH = 'templates/GITIGNORE_WORKLOG.txt';

const DEFAULT_COMMITTED_HOOKS_DIR = '.githooks';

type NormalizedInitOptions = {
  projectName?: string;
  prefix?: string;
  autoExport?: boolean;
  autoSync?: boolean;
  agentsTemplateAction: AgentTemplateAction;
  workflowInline: boolean;
  statsPluginOverwrite: boolean;
};

function normalizeBooleanOption(value: string | undefined, flagName: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['n', 'no', 'false', '0'].includes(normalized)) return false;
  throw new Error(`Invalid value for ${flagName}. Use yes or no.`);
}

function normalizeAgentTemplateAction(value?: string): AgentTemplateAction | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'overwrite' || normalized === 'o') return 'overwrite';
  if (normalized === 'append' || normalized === 'a') return 'append';
  if (normalized === 'skip' || normalized === 'm' || normalized === 'manual' || normalized === 'manage') return 'skip';
  throw new Error('Invalid value for --agents-template. Use overwrite, append, or skip.');
}

function normalizeInitOptions(options: InitOptions): NormalizedInitOptions {
  const projectName = options.projectName?.trim();
  if (options.projectName !== undefined && (!projectName || projectName === '')) {
    throw new Error('Project name is required when --project-name is provided.');
  }

  const prefix = options.prefix?.trim();
  if (options.prefix !== undefined && (!prefix || prefix === '')) {
    throw new Error('Issue ID prefix is required when --prefix is provided.');
  }

  return {
    projectName,
    prefix,
    autoExport: normalizeBooleanOption(options.autoExport, '--auto-export'),
    autoSync: normalizeBooleanOption(options.autoSync, '--auto-sync'),
    agentsTemplateAction: normalizeAgentTemplateAction(options.agentsTemplate) ?? 'skip',
    workflowInline: normalizeBooleanOption(options.workflowInline, '--workflow-inline') ?? false,
    statsPluginOverwrite: normalizeBooleanOption(options.statsPluginOverwrite, '--stats-plugin-overwrite') ?? false,
  };
}

function ensureGitignore(options: { silent: boolean }): { updated: boolean; present: boolean; gitignorePath?: string; added?: string[]; reason?: string } {
  let gitignorePath = path.join(process.cwd(), '.gitignore');

  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (repoRoot) {
      gitignorePath = path.join(repoRoot, '.gitignore');
    }
  } catch {
    // Not a git repo
  }

  let existing = '';
  try {
    if (fs.existsSync(gitignorePath)) {
      existing = fs.readFileSync(gitignorePath, 'utf-8');
    }
  } catch (e) {
    return { updated: false, present: false, gitignorePath, reason: (e as Error).message };
  }

  if (existing && hasWorklogGitignoreSection(existing)) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, added: [] };
  }

  const templatePath = locateGitignoreTemplate();
  if (!templatePath) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: 'gitignore template not found' };
  }

  let templateContent = '';
  try {
    templateContent = fs.readFileSync(templatePath, 'utf-8');
  } catch (e) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: (e as Error).message };
  }

  if (!templateContent.trim()) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: 'gitignore template is empty' };
  }

  const sectionLines = templateContent.split(/\r?\n/).filter(line => line.length > 0);

  let out = existing;
  if (out.length > 0 && !out.endsWith('\n')) {
    out += '\n';
  }
  if (out.length > 0 && !out.endsWith('\n\n')) {
    out += '\n';
  }
  if (!templateContent.endsWith('\n')) {
    templateContent += '\n';
  }
  out += templateContent;

  try {
    fs.writeFileSync(gitignorePath, out, { encoding: 'utf-8' });
  } catch (e) {
    return { updated: false, present: fs.existsSync(gitignorePath), gitignorePath, reason: (e as Error).message };
  }

  if (!options.silent) {
    console.log(`✓ Updated .gitignore at ${gitignorePath}`);
  }
  return { updated: true, present: true, gitignorePath, added: sectionLines };
}

function installPrePushHook(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; hookPath?: string; reason?: string } {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  let repoRoot = '';
  let hooksPath = '';
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    hooksPath = execSync('git rev-parse --git-path hooks', { encoding: 'utf8' }).trim();
  } catch (e) {
    return { installed: false, skipped: true, present: false, reason: 'unable to locate git hooks directory' };
  }

  const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.join(repoRoot, hooksPath);
  const hookFile = path.join(hooksDir, 'pre-push');

  const hookScript =
    `#!/bin/sh\n` +
    `# ${WORKLOG_PRE_PUSH_HOOK_MARKER}\n` +
    `# Auto-sync Worklog data before pushing.\n` +
    `# Set WORKLOG_SKIP_PRE_PUSH=1 to bypass.\n` +
    `\n` +
    `set -e\n` +
    `\n` +
    `if [ \"$WORKLOG_SKIP_PRE_PUSH\" = \"1\" ]; then\n` +
    `  exit 0\n` +
    `fi\n` +
    `\n` +
    `# Avoid recursion when worklog sync pushes refs/worklog/data.\n` +
    `skip=0\n` +
    `while read local_ref local_sha remote_ref remote_sha; do\n` +
    `  if [ \"$remote_ref\" = \"refs/worklog/data\" ]; then\n` +
    `    skip=1\n` +
    `  fi\n` +
    `done\n` +
    `\n` +
    `if [ \"$skip\" = \"1\" ]; then\n` +
    `  exit 0\n` +
    `fi\n` +
    `\n` +
    `if command -v wl >/dev/null 2>&1; then\n` +
    `  WL=wl\n` +
    `elif command -v worklog >/dev/null 2>&1; then\n` +
    `  WL=worklog\n` +
    `else\n` +
    `  echo \"worklog: wl/worklog not found; skipping pre-push sync\" >&2\n` +
    `  exit 0\n` +
    `fi\n` +
    `\n` +
    `\"$WL\" sync\n` +
    `\n` +
    `exit 0\n`;

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    if (fs.existsSync(hookFile)) {
      const existing = fs.readFileSync(hookFile, 'utf-8');
      if (existing.includes(WORKLOG_PRE_PUSH_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, hookPath: hookFile, reason: 'hook already installed' };
      }
      return { installed: false, skipped: true, present: true, hookPath: hookFile, reason: `pre-push hook already exists at ${hookFile} (not overwriting)` };
    }

    fs.writeFileSync(hookFile, hookScript, { encoding: 'utf-8', mode: 0o755 });
    try {
      fs.chmodSync(hookFile, 0o755);
    } catch {
      // ignore
    }

    if (!options.silent) {
      console.log(`✓ Installed git pre-push hook at ${hookFile}`);
    }
    return { installed: true, skipped: false, present: true, hookPath: hookFile };
  } catch (e) {
    return { installed: false, skipped: true, present: false, hookPath: hookFile, reason: (e as Error).message };
  }
}

function installPostPullHooks(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; hookPaths?: string[]; centralScriptPath?: string; reason?: string } {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  } catch {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  let repoRoot = '';
  let hooksPath = '';
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
    hooksPath = execSync('git rev-parse --git-path hooks', { encoding: 'utf8' }).trim();
  } catch (e) {
    return { installed: false, skipped: true, present: false, reason: 'unable to locate git hooks directory' };
  }

  const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.join(repoRoot, hooksPath);
  const hookNames = ['post-merge', 'post-checkout', 'post-rewrite'];
  const hookFiles = hookNames.map(f => path.join(hooksDir, f));

  // Central script that performs the post-pull sync. Hook wrappers will call this
  // central script so we only manage one implementation location.
  const centralScript = path.join(hooksDir, 'worklog-post-pull');
   const centralScriptContent =
     `#!/bin/sh\n` +
     `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
     `# Central Worklog post-pull sync script.\n` +
     `# Set WORKLOG_SKIP_POST_PULL=1 to bypass.\n` +
     `set -e\n` +
     `if [ \"$WORKLOG_SKIP_POST_PULL\" = \"1\" ]; then\n` +
     `  exit 0\n` +
     `fi\n` +
     `if command -v wl >/dev/null 2>&1; then\n` +
     `  WL=wl\n` +
     `elif command -v worklog >/dev/null 2>&1; then\n` +
     `  WL=worklog\n` +
     `else\n` +
     `  echo \"worklog: wl/worklog not found; skipping post-pull sync\" >&2\n` +
     `  exit 0\n` +
     `fi\n` +
     `# Run sync but do not fail the checkout/merge if sync is not available or fails\n` +
     `if \"$WL\" sync >/dev/null 2>&1; then\n` +
     `  :\n` +
     `else\n` +
     `  # Check if this is a new checkout/worktree (no .worklog directory)\n` +
     `  if [ ! -d \".worklog\" ]; then\n` +
     `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
     `  else\n` +
     `    echo \"worklog: sync failed; continuing\" >&2\n` +
     `  fi\n` +
     `fi\n` +
     `exit 0\n`;

  // Small wrapper hooks that call the central script. These are the files Git
  // expects to exist: post-merge, post-checkout, post-rewrite.
  const wrapperContent = (centralPath: string) => (
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Wrapper that delegates to central Worklog post-pull script.\n` +
    `exec \"${centralPath}\" \"$@\"\n`
  );

  try {
    fs.mkdirSync(hooksDir, { recursive: true });

    // Ensure central script is present (but don't overwrite user-provided scripts)
    if (fs.existsSync(centralScript)) {
      const existing = fs.readFileSync(centralScript, 'utf-8');
      if (!existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, hookPaths: [centralScript], reason: `central script exists at ${centralScript} (not overwriting)` };
      }
    } else {
      fs.writeFileSync(centralScript, centralScriptContent, { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(centralScript, 0o755); } catch {}
    }

    const installedPaths: string[] = [];
    for (const hookFile of hookFiles) {
      if (fs.existsSync(hookFile)) {
        const existing = fs.readFileSync(hookFile, 'utf-8');
        if (existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
          // already installed for this hook, skip
          installedPaths.push(hookFile);
          continue;
        }
        // don't overwrite user hooks
        return { installed: false, skipped: true, present: true, hookPaths: installedPaths, reason: `hook already exists at ${hookFile} (not overwriting)` };
      }

      fs.writeFileSync(hookFile, wrapperContent(centralScript), { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(hookFile, 0o755); } catch {}
      installedPaths.push(hookFile);
    }

    if (!options.silent) {
      console.log(`✓ Installed git post-pull hooks (wrappers) at ${hooksDir}`);
    }
    return { installed: true, skipped: false, present: true, hookPaths: installedPaths, centralScriptPath: centralScript };
  } catch (e) {
    return { installed: false, skipped: true, present: false, hookPaths: hookFiles, reason: (e as Error).message };
  }
}

function installCommittedHooks(options: { silent: boolean }): { installed: boolean; skipped: boolean; present: boolean; dirPath?: string; files?: string[]; reason?: string } {
  // Create a repository-tracked hooks directory (e.g. .githooks) with our
  // central post-pull script and wrapper hooks. We do NOT change git config
  // here; the user can opt-in by running `git config core.hooksPath .githooks`.
  let repoRoot: string | null = resolveRepoRoot();
  if (!repoRoot) {
    return { installed: false, skipped: true, present: false, reason: 'not a git repository' };
  }

  const dir = path.join(repoRoot, DEFAULT_COMMITTED_HOOKS_DIR);
  const centralScript = path.join(dir, 'worklog-post-pull');
  const hookNames = ['post-merge', 'post-checkout', 'post-rewrite', 'pre-push'];
  const hookFiles = hookNames.map(n => path.join(dir, n));

  const centralScriptContent =
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Central Worklog post-pull sync script (committed hooks).\n` +
    `# Set WORKLOG_SKIP_POST_PULL=1 to bypass.\n` +
    `set -e\n` +
    `if [ \"$WORKLOG_SKIP_POST_PULL\" = \"1\" ]; then\n` +
    `  exit 0\n` +
    `fi\n` +
    `if command -v wl >/dev/null 2>&1; then\n` +
    `  WL=wl\n` +
    `elif command -v worklog >/dev/null 2>&1; then\n` +
    `  WL=worklog\n` +
    `else\n` +
    `  echo \"worklog: wl/worklog not found; skipping post-pull sync\" >&2\n` +
    `  exit 0\n` +
    `fi\n` +
    `if \"$WL\" sync >/dev/null 2>&1; then\n` +
    `  :\n` +
    `else\n` +
    `  if [ ! -d \".worklog\" ]; then\n` +
    `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
    `  else\n` +
    `    echo \"worklog: sync failed; continuing\" >&2\n` +
    `  fi\n` +
    `fi\n` +
    `exit 0\n`;

  const wrapperContent = (centralPath: string) => (
    `#!/bin/sh\n` +
    `# ${WORKLOG_POST_PULL_HOOK_MARKER}\n` +
    `# Wrapper that delegates to central Worklog post-pull script (committed hooks).\n` +
    `exec \"${centralPath}\" \"$@\"\n`
  );

   const prePushContent =
     `#!/bin/sh\n` +
     `# ${WORKLOG_PRE_PUSH_HOOK_MARKER}\n` +
     `# Auto-sync Worklog data before pushing (committed hooks).\n` +
     `# Set WORKLOG_SKIP_PRE_PUSH=1 to bypass.\n` +
     `set -e\n` +
     `if [ \"$WORKLOG_SKIP_PRE_PUSH\" = \"1\" ]; then\n` +
     `  exit 0\n` +
     `fi\n` +
     `skip=0\n` +
     `while read local_ref local_sha remote_ref remote_sha; do\n` +
     `  if [ \"$remote_ref\" = \"refs/worklog/data\" ]; then\n` +
     `    skip=1\n` +
     `  fi\n` +
     `done\n` +
     `if [ \"$skip\" = \"1\" ]; then\n` +
     `  exit 0\n` +
     `fi\n` +
     `if command -v wl >/dev/null 2>&1; then\n` +
     `  WL=wl\n` +
     `elif command -v worklog >/dev/null 2>&1; then\n` +
     `  WL=worklog\n` +
     `else\n` +
     `  echo \"worklog: wl/worklog not found; skipping pre-push sync\" >&2\n` +
     `  exit 0\n` +
     `fi\n` +
     `\"$WL\" sync\n` +
     `exit 0\n`;

    const postCheckoutContent =
      `#!/bin/sh\n` +
      `# ${WORKLOG_POST_CHECKOUT_HOOK_MARKER}\n` +
      `# Auto-sync Worklog data after branch checkout (committed hooks).\n` +
      `# Set WORKLOG_SKIP_POST_CHECKOUT=1 to bypass.\n` +
      `set -e\n` +
      `if [ \"$WORKLOG_SKIP_POST_CHECKOUT\" = \"1\" ]; then\n` +
      `  exit 0\n` +
      `fi\n` +
      `if command -v wl >/dev/null 2>&1; then\n` +
      `  WL=wl\n` +
      `elif command -v worklog >/dev/null 2>&1; then\n` +
      `  WL=worklog\n` +
      `else\n` +
      `  echo \"worklog: wl/worklog not found; skipping post-checkout sync\" >&2\n` +
      `  exit 0\n` +
      `fi\n` +
      `if \"$WL\" sync >/dev/null 2>&1; then\n` +
      `  :\n` +
      `else\n` +
      `  if [ ! -d \".worklog\" ]; then\n` +
      `    echo \"worklog: not initialized in this checkout/worktree. Run \\\"wl init\\\" to set up this location.\" >&2\n` +
      `  else\n` +
      `    echo \"worklog: sync failed; continuing\" >&2\n` +
      `  fi\n` +
      `fi\n` +
      `exit 0\n`;

  try {
    fs.mkdirSync(dir, { recursive: true });

    // central script
    if (fs.existsSync(centralScript)) {
      const existing = fs.readFileSync(centralScript, 'utf-8');
      if (!existing.includes(WORKLOG_POST_PULL_HOOK_MARKER)) {
        return { installed: false, skipped: true, present: true, dirPath: dir, reason: `central script exists at ${centralScript} (not overwriting)` };
      }
    } else {
      fs.writeFileSync(centralScript, centralScriptContent, { encoding: 'utf-8', mode: 0o755 });
      try { fs.chmodSync(centralScript, 0o755); } catch {}
    }

    const installed: string[] = [];
    for (const file of hookFiles) {
       if (fs.existsSync(file)) {
         const existing = fs.readFileSync(file, 'utf-8');
         if (existing.includes(WORKLOG_POST_PULL_HOOK_MARKER) || existing.includes(WORKLOG_PRE_PUSH_HOOK_MARKER) || existing.includes(WORKLOG_POST_CHECKOUT_HOOK_MARKER)) {
           installed.push(file);
           continue;
         }
         return { installed: false, skipped: true, present: true, dirPath: dir, files: installed, reason: `hook already exists at ${file} (not overwriting)` };
       }

       const basename = path.basename(file);
       if (basename === 'pre-push') {
         fs.writeFileSync(file, prePushContent, { encoding: 'utf-8', mode: 0o755 });
       } else if (basename === 'post-checkout') {
         fs.writeFileSync(file, postCheckoutContent, { encoding: 'utf-8', mode: 0o755 });
       } else {
         fs.writeFileSync(file, wrapperContent(centralScript), { encoding: 'utf-8', mode: 0o755 });
       }
      try { fs.chmodSync(file, 0o755); } catch {}
      installed.push(file);
    }

    if (!options.silent) {
      console.log(`✓ Wrote committed hooks to ${dir}`);
      console.log(`  To enable these for this repository run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
    }

    return { installed: true, skipped: false, present: true, dirPath: dir, files: installed };
  } catch (e) {
    return { installed: false, skipped: true, present: false, dirPath: dir, files: hookFiles, reason: (e as Error).message };
  }
}

function getSyncDefaults(config?: ReturnType<typeof loadConfig>) {
  return {
    gitRemote: config?.syncRemote || DEFAULT_GIT_REMOTE,
    gitBranch: config?.syncBranch || DEFAULT_GIT_BRANCH,
  };
}

function resolveRepoRoot(): string | null {
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return repoRoot || null;
  } catch {
    return null;
  }
}

function resolveProjectRoot(): string {
  return resolveRepoRoot() || process.cwd();
}

function locateAgentTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKLOG_AGENT_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : null;
}

function locateExampleStatsPlugin(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, 'examples', 'stats-plugin.mjs');
  return fs.existsSync(candidate) ? candidate : null;
}

function locateWorkflowTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKFLOW_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : null;
}

function locateGitignoreTemplate(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, '..', '..');
  const candidate = path.join(packageRoot, WORKLOG_GITIGNORE_TEMPLATE_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : null;
}

function hasWorklogGitignoreSection(content: string): boolean {
  return content.includes(WORKLOG_GITIGNORE_SECTION_START) && content.includes(WORKLOG_GITIGNORE_SECTION_END);
}

async function promptWorkflowInstall(questionText: string, forceAnswer?: boolean): Promise<boolean> {
  if (forceAnswer !== undefined) return forceAnswer;
  return promptYesNo(questionText);
}

async function ensureWorkflowTemplateInstalled(options: { silent: boolean; agentTemplateAction?: string; agentDestinationPath?: string }) {
  // We do not write a standalone WORKFLOW.md into the repository. If an
  // agent destination path is provided, inline the workflow content into the
  // agent file. Otherwise, return a skipped result explaining that writing
  // to disk is disabled by design.
  const templatePath = locateWorkflowTemplate();
  if (!templatePath) return { installed: false, skipped: true, reason: 'workflow template not found', templatePath: null, destinationPath: null };

  const projectRoot = resolveProjectRoot();
  const repoWorkflowPath = path.join(projectRoot, WORKFLOW_DESTINATION_FILENAME);

  // If caller provided an agentDestinationPath, attempt to inline workflow
  // content into the agent file (prefer repo copy if present, otherwise packaged template).
  if (options.agentDestinationPath) {
    try {
      // insertWorkflowLoaderIntoAgents will read repo/workspace or packaged
      // template as needed and perform the insertion. It will also avoid
      // duplicating content if already present.
      const insertResult = insertWorkflowLoaderIntoAgents(options.agentDestinationPath);
      if (insertResult.inserted) {
        if (!options.silent) console.log(`✓ Inlined WORKFLOW content into ${options.agentDestinationPath}`);
        return { installed: true, skipped: false, templatePath, destinationPath: null };
      }
      // Already present is not an error — report as skipped
      if (insertResult.reason === 'already present') return { installed: false, skipped: true, reason: 'already in place', templatePath, destinationPath: null };
      return { installed: false, skipped: true, reason: insertResult.reason || 'insertion failed', templatePath, destinationPath: null };
    } catch (e) {
      return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath: null };
    }
  }

  // No agent destination provided: do not create a standalone WORKFLOW.md file.
  return { installed: false, skipped: true, reason: 'not writing WORKFLOW.md to repository (inlining only)', templatePath, destinationPath: null };
}

function insertWorkflowLoaderIntoAgents(agentPath: string) {
  try {
    if (!fs.existsSync(agentPath)) return { inserted: false, reason: 'agents file not found' };

    // Determine workflow content: prefer repository WORKFLOW.md, fall back to packaged template
    const projectRoot = resolveProjectRoot();
    const repoWorkflowPath = path.join(projectRoot, WORKFLOW_DESTINATION_FILENAME);
    let workflowContent: string | null = null;
    if (fs.existsSync(repoWorkflowPath)) {
      workflowContent = normalizeContent(fs.readFileSync(repoWorkflowPath, 'utf-8'));
    } else {
      const packaged = locateWorkflowTemplate();
      if (packaged && fs.existsSync(packaged)) {
        workflowContent = normalizeContent(fs.readFileSync(packaged, 'utf-8'));
      }
    }
    if (!workflowContent) return { inserted: false, reason: 'workflow file not found' };

    const existing = fs.readFileSync(agentPath, 'utf-8');

    // Avoid inserting twice (if the agent file already contains the workflow markers)
    if (existing.includes('<!-- WORKFLOW: start -->')) return { inserted: false, reason: 'already present' };

    const out = `<!-- WORKFLOW: start -->\n${workflowContent}\n<!-- WORKFLOW: end -->\n\n${existing}`;
    fs.writeFileSync(agentPath, out, { encoding: 'utf-8' });
    return { inserted: true, path: agentPath };
  } catch (e) {
    return { inserted: false, reason: (e as Error).message };
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      const t = String(answer || '').trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

async function ensureStatsPluginInstalled(options: { silent: boolean; overwrite?: boolean }) {
  const templatePath = locateExampleStatsPlugin();
  if (!templatePath) return { installed: false, skipped: true, reason: 'template not found', templatePath: null, destinationPath: null };

  const worklogDir = resolveWorklogDir();
  const pluginsDir = path.join(worklogDir, 'plugins');
  const destinationPath = path.join(pluginsDir, 'stats-plugin.mjs');

  try {
    const templateContent = normalizeContent(fs.readFileSync(templatePath, 'utf-8'));
    if (fs.existsSync(destinationPath)) {
      const existingContent = normalizeContent(fs.readFileSync(destinationPath, 'utf-8'));
      const already = existingContent === templateContent;
      if (already) return { installed: false, skipped: true, reason: 'already in place', templatePath, destinationPath };
      if (options.overwrite === false) return { installed: false, skipped: true, reason: 'user declined', templatePath, destinationPath };
      if (options.overwrite !== true) {
        if (options.silent) return { installed: false, skipped: true, reason: 'confirmation required', templatePath, destinationPath };

        const answer = await promptYesNo('A stats plugin already exists at .worklog/plugins/stats-plugin.mjs. Overwrite? (y/N): ');
        if (!answer) return { installed: false, skipped: true, reason: 'user declined', templatePath, destinationPath };
      }
    }

    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
    return { installed: true, skipped: false, templatePath, destinationPath };
  } catch (e) {
    return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath };
  }
}

function resolveAgentDestination(projectRoot: string): string {
  return path.join(projectRoot, WORKLOG_AGENT_DESTINATION_FILENAME);
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd();
}

type AgentTemplateAction = 'overwrite' | 'append' | 'skip';

async function promptAgentTemplateAction(): Promise<AgentTemplateAction> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('AGENTS.md already exists. Overwrite, append, or manage manually? (o/a/m): ', answer => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'o' || trimmed === 'overwrite') {
        resolve('overwrite');
        return;
      }
      if (trimmed === 'a' || trimmed === 'append') {
        resolve('append');
        return;
      }
      resolve('skip');
    });
  });
}

async function ensureAgentTemplateInstalled(options: { silent: boolean; action?: AgentTemplateAction }) {
  const templatePath = locateAgentTemplate();
  if (!templatePath) {
    return { installed: false, skipped: true, reason: 'template not found', templatePath: null, destinationPath: null };
  }

  const projectRoot = resolveProjectRoot();
  const destinationPath = resolveAgentDestination(projectRoot);

  try {
    const templateContent = normalizeContent(fs.readFileSync(templatePath, 'utf-8'));
    if (fs.existsSync(destinationPath)) {
      const existingContent = normalizeContent(fs.readFileSync(destinationPath, 'utf-8'));
      // Consider the template present if the template content is included in the existing file
      const templateAlreadyPresent = existingContent.includes(templateContent);
      if (templateAlreadyPresent) {
        return { installed: false, skipped: true, reason: 'template already in place', templatePath, destinationPath };
      }
      if (options.action === 'skip') {
        return { installed: false, skipped: true, reason: 'user chose to manage manually', templatePath, destinationPath };
      }

      if (options.action === 'overwrite') {
        fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Overwrote AGENTS template at ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, overwritten: true };
      }

      if (options.action === 'append') {
        const separator = existingContent.endsWith('\n') ? '\n' : '\n\n';
        fs.appendFileSync(destinationPath, `${separator}${templateContent}\n`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Appended AGENTS template to ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, appended: true };
      }

      if (options.silent) {
        return { installed: false, skipped: true, reason: 'confirmation required', templatePath, destinationPath };
      }

      printAgentTemplateSummary();
      const resolvedAction = await promptAgentTemplateAction();
      if (resolvedAction === 'skip') {
        return { installed: false, skipped: true, reason: 'user chose to manage manually', templatePath, destinationPath };
      }

      if (resolvedAction === 'overwrite') {
        fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
        if (!options.silent) {
          console.log(`✓ Overwrote AGENTS template at ${destinationPath}`);
        }
        return { installed: true, skipped: false, templatePath, destinationPath, overwritten: true };
      }

      const separator = existingContent.endsWith('\n') ? '\n' : '\n\n';
      fs.appendFileSync(destinationPath, `${separator}${templateContent}\n`, { encoding: 'utf-8' });
      if (!options.silent) {
        console.log(`✓ Appended AGENTS template to ${destinationPath}`);
      }
      return { installed: true, skipped: false, templatePath, destinationPath, appended: true };
    }

    fs.writeFileSync(destinationPath, `${templateContent}\n`, { encoding: 'utf-8' });
    if (!options.silent) {
      console.log(`✓ Installed AGENTS template at ${destinationPath}`);
    }
    return { installed: true, skipped: false, templatePath, destinationPath };
  } catch (e) {
    return { installed: false, skipped: true, reason: (e as Error).message, templatePath, destinationPath };
  }
}

function printAgentTemplateSummary(): void {
  console.log('You already have an AGENTS.md file, but it is different from the template provided by Worklog.');
  console.log('');
  console.log('The AGENTS.md template adds Worklog-aware instructions so agents use wl for tracking, manage workflow stages, and follow the project rules for issues, priorities, and sync.');
  console.log('');
  console.log('If you do not add this content to AGENTS.md, you are expected to add your own Worklog-aware instructions to your agent definition files.');
  console.log('');
}

async function performInitSync(dataPath: string, prefix?: string, isJsonMode: boolean = false): Promise<void> {
  const config = loadConfig();
  const defaults = getSyncDefaults(config || undefined);
  // Create DB with autoExport disabled to avoid intermediate exports while
  // importing items and comments separately. We'll write the merged JSONL
  // once after both imports are applied.
  const db = new (await import('../database.js')).WorklogDatabase(
    prefix || config?.prefix || 'WL',
    undefined,
    dataPath,
    /* autoExport */ false
  );
  
  const localItems = db.getAll();
  const localComments = db.getAllComments();
  const localEdges = db.getAllDependencyEdges();
  
  const gitTarget = { remote: defaults.gitRemote, branch: defaults.gitBranch };
  const remoteContent = await getRemoteDataFileContent(dataPath, gitTarget);
  
  let remoteItems: any[] = [];
  let remoteComments: any[] = [];
  let remoteEdges: DependencyEdge[] = [];
  if (remoteContent) {
    const remoteData = importFromJsonlContent(remoteContent);
    remoteItems = remoteData.items;
    remoteComments = remoteData.comments;
    remoteEdges = remoteData.dependencyEdges || [];
  }
  
  const itemMergeResult = mergeWorkItems(localItems, remoteItems);
  const commentMergeResult = mergeComments(localComments, remoteComments);
  const edgeMergeResult = mergeDependencyEdges(localEdges, remoteEdges);
  
  const autoSyncEnabled = config?.autoSync === true;
  if (autoSyncEnabled) {
    db.setAutoSync(false);
  }
  db.import(itemMergeResult.merged, edgeMergeResult.merged);
  db.importComments(commentMergeResult.merged);
  if (autoSyncEnabled) {
    db.setAutoSync(true, () => Promise.resolve());
  }
  
  exportToJsonl(itemMergeResult.merged, commentMergeResult.merged, dataPath, edgeMergeResult.merged);
  await gitPushDataFileToBranch(dataPath, 'Sync work items and comments', gitTarget);
}

export default function register(ctx: PluginContext): void {
  const { program, version, dataPath, output } = ctx;
  
  program
    .command('init')
    .description('Initialize worklog configuration')
    .option('--project-name <name>', 'Project name')
    .option('--prefix <prefix>', 'Issue ID prefix (e.g., WI, PROJ, TASK)')
    .option('--auto-export <yes|no>', 'Auto-export data to JSONL after changes')
    .option('--auto-sync <yes|no>', 'Auto-sync data to git after changes')
    .option('--agents-template <overwrite|append|skip>', 'What to do when AGENTS.md exists (default: skip)')
    .option('--workflow-inline <yes|no>', 'Inline workflow into AGENTS.md when prompted (default: no)')
    .option('--stats-plugin-overwrite <yes|no>', 'Overwrite existing stats plugin if present (default: no)')
    .action(async (_options: InitOptions) => {
      const isJsonMode = program.opts().json;
      let normalizedOptions: NormalizedInitOptions;
      try {
        normalizedOptions = normalizeInitOptions(_options);
      } catch (error) {
        const message = (error as Error).message;
        if (isJsonMode) {
          output.json({ success: false, error: message });
        } else {
          console.error(`Error: ${message}`);
        }
        process.exit(1);
        return;
      }
      
      if (configExists()) {
        if (!isInitialized()) {
          writeInitSemaphore(version);
        }
        
        const config = loadConfig();
        const initInfo = readInitSemaphore();
        
        if (isJsonMode) {
          const gitignoreResult = ensureGitignore({ silent: true });
          const hookResult = installPrePushHook({ silent: true });
          const postPullResult = installPostPullHooks({ silent: true });
          const committedHooksResult = installCommittedHooks({ silent: true });
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: true, action: normalizedOptions.agentsTemplateAction });
          const statsPluginResult = await ensureStatsPluginInstalled({ silent: true, overwrite: normalizedOptions.statsPluginOverwrite });
          output.json({
            success: true,
            message: 'Configuration already exists',
            config: {
              projectName: config?.projectName,
              prefix: config?.prefix
            },
            version: initInfo?.version || version,
            initializedAt: initInfo?.initializedAt,
            gitignore: gitignoreResult,
            gitHook: hookResult,
            postPullHooks: postPullResult,
            committedHooks: committedHooksResult,
            agentTemplate: agentTemplateResult,
            statsPlugin: statsPluginResult
          });
          return;
        } else {
          try {
            const updatedConfig = await initConfig(config, {
              projectName: normalizedOptions.projectName,
              prefix: normalizedOptions.prefix,
              autoExport: normalizedOptions.autoExport,
              autoSync: normalizedOptions.autoSync,
            } satisfies InitConfigOptions);
            writeInitSemaphore(version);
            
            console.log('\n' + chalk.blue('## Git Sync') + '\n');
            console.log('Syncing database...');
            
            try {
              await performInitSync(dataPath, updatedConfig?.prefix, false);
            } catch (syncError) {
              console.log('\nSync failed (this is OK for new projects without remote data)');
              console.log(`  ${(syncError as Error).message}`);
            }

            console.log('\n' + chalk.blue('## Gitignore') + '\n');
            const gitignoreResult = ensureGitignore({ silent: false });
            if (gitignoreResult.updated) {
              console.log(`.gitignore updated at ${gitignoreResult.gitignorePath} (added ${gitignoreResult.added?.length || 0} entries)`);
            } else if (gitignoreResult.present) {
              console.log('.gitignore is already up-to-date');
            } else {
              if (gitignoreResult.reason) {
                console.log(`.gitignore not updated: ${gitignoreResult.reason}`);
              } else {
                console.log('.gitignore: no changes required');
              }
            }

            console.log('\n' + chalk.blue('## Git Hooks') + '\n');
            const hookResult = installPrePushHook({ silent: false });
            // Try to install post-pull hooks too, but don't fail init if they can't be installed
            const postPullResult = installPostPullHooks({ silent: true });
            // Also write a committed hooks directory (.githooks) the user may enable
            const committedHooksResult = installCommittedHooks({ silent: true });
            if (hookResult.present) {
              // Use consistent phrasing with post-pull hooks
              if (hookResult.hookPath) {
                console.log(`Git pre-push hook: installed at ${hookResult.hookPath}`);
              } else {
                console.log('Git pre-push hook: present');
              }
            } else {
              console.log('Git pre-push hook: not present');
            }
            if (!hookResult.installed && hookResult.reason && hookResult.reason !== 'hook already installed') {
              console.log(`\ngit pre-push hook not installed: ${hookResult.reason}`);
            }
            if (postPullResult && postPullResult.installed) {
              // Prefer to show the central script path when available
              if ((postPullResult as any).centralScriptPath) {
                console.log(`Git post-pull hooks: installed (central script at ${(postPullResult as any).centralScriptPath})`);
              } else {
                console.log(`Git post-pull hooks: installed at ${postPullResult.hookPaths?.join(', ')}`);
              }
            } else if (postPullResult && postPullResult.skipped) {
              // don't spam the user when we silently skipped
            } else if (postPullResult && postPullResult.reason) {
              console.log(`Git post-pull hooks: not installed: ${postPullResult.reason}`);
            }

            if (committedHooksResult && committedHooksResult.installed) {
              console.log(`Git committed hooks: written to ${committedHooksResult.dirPath}. To enable run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
            } else if (committedHooksResult && committedHooksResult.skipped && committedHooksResult.reason) {
              // skip quietly
            }

            console.log('\n' + chalk.blue('## Agent Template') + '\n');
            const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: false, action: normalizedOptions.agentsTemplateAction });
            if (!agentTemplateResult.installed && agentTemplateResult.reason === 'template already in place') {
              console.log('AGENTS.md already matches the Worklog template.');
            }
            if (!agentTemplateResult.installed && agentTemplateResult.reason && agentTemplateResult.reason !== 'template already in place') {
              console.log(`Note: AGENTS template not installed: ${agentTemplateResult.reason}`);
            }
            console.log('');
            // Offer workflow integration after AGENTS.md handling
            const workflowTemplatePath = locateWorkflowTemplate();
            if (workflowTemplatePath) {
              const projectRoot = resolveProjectRoot();
              const agentDestination = resolveAgentDestination(projectRoot);
                

              if (fs.existsSync(agentDestination)) {
                const agentContent = fs.readFileSync(agentDestination, 'utf-8');
                // If loader already present, note it and still offer to install WORKFLOW.md
                if (agentContent.includes('<!-- WORKFLOW: start -->')) {
                  // If loader present, report and do not prompt.
                  console.log('Workflow already inlined in AGENTS.md.');
                  // Report status of WORKFLOW.md (installed / exists but differs / missing) without prompting
                  try {
                    const projectRootCheck = resolveProjectRoot();
                    const wfDest = path.join(projectRootCheck, WORKFLOW_DESTINATION_FILENAME);
                    if (fs.existsSync(wfDest)) {
                      const existingWf = normalizeContent(fs.readFileSync(wfDest, 'utf-8'));
                      const templateWf = normalizeContent(fs.readFileSync(workflowTemplatePath, 'utf-8'));
                      if (existingWf.includes(templateWf)) {
                        // WORKFLOW.md already matches template — loader presence already communicates this intent, skip duplicate line
                      } else {
                        
                      }
                    } else {
                      
                    }
                  } catch (e) {
                    
                  }
                } else {
                  // Loader missing: offer to insert loader and install WORKFLOW.md
                  const wantBoth = await promptWorkflowInstall('Would you like to inline the workflow into AGENTS.md? (y/N): ', normalizedOptions.workflowInline);
                  if (wantBoth) {
                    await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                    insertWorkflowLoaderIntoAgents(agentDestination);
                  } else {
                  // user skipped — do not add summary lines
                  }
                }
              } else {
                // No AGENTS.md present: offer to install only WORKFLOW.md
                const wantWorkflow = await promptWorkflowInstall('No AGENTS.md found. Would you like to create AGENTS.md with the workflow inlined? (y/N): ', normalizedOptions.workflowInline);
                if (wantWorkflow) {
                  await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                } else {
                  // user skipped — no summary
                }
              }

               // We no longer print a workflowReport summary; helpers print output
            }
            // (note: reporting already emitted above)
            // Offer to install example stats plugin
            console.log('\n' + chalk.blue('## Install plugins') + '\n');
            const statsPluginResult = await ensureStatsPluginInstalled({ silent: false, overwrite: normalizedOptions.statsPluginOverwrite });
            if (statsPluginResult.installed) {
              console.log(`✓ Installed example stats plugin at ${statsPluginResult.destinationPath}`);
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
              console.log('Stats plugin already present.');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
              console.log('Stats plugin installation skipped by user.');
            } else if (statsPluginResult.skipped && statsPluginResult.reason) {
              console.log(`Stats plugin: ${statsPluginResult.reason}`);
            }

            // Summary of actions
            console.log('\n\n' + chalk.blue('## Summary') + '\n');
            // gitignore
            if (gitignoreResult.updated) {
              console.log(' - .gitignore: updated');
            } else if (gitignoreResult.present) {
              console.log(' - .gitignore: present (no changes)');
            } else {
              console.log(` - .gitignore: not updated${gitignoreResult.reason ? `: ${gitignoreResult.reason}` : ''}`);
            }
            // pre-push hook
            if (hookResult.installed) {
              console.log(' - Git pre-push hook: installed');
            } else if (hookResult.skipped && hookResult.present) {
              console.log(' - Git pre-push hook: present (not modified)');
            } else {
              console.log(` - Git pre-push hook: not installed${hookResult.reason ? `: ${hookResult.reason}` : ''}`);
            }
            // post-pull hooks
            if (postPullResult && (postPullResult as any).installed) {
              console.log(' - Git post-pull hooks: installed');
            } else if (postPullResult && (postPullResult as any).skipped) {
              console.log(' - Git post-pull hooks: skipped');
            } else if (postPullResult && (postPullResult as any).reason) {
              console.log(` - Git post-pull hooks: not installed: ${(postPullResult as any).reason}`);
            }
            // committed hooks
            if (committedHooksResult && committedHooksResult.installed) {
              console.log(' - Git committed hooks: written');
            } else if (committedHooksResult && committedHooksResult.skipped) {
              console.log(' - Git committed hooks: skipped');
            }
            // agent template
            if (agentTemplateResult.installed) {
              console.log(' - AGENTS.md: installed');
            } else if (agentTemplateResult.skipped && agentTemplateResult.reason === 'template already in place') {
              console.log(' - AGENTS.md: already in place');
            } else if (agentTemplateResult.skipped) {
              console.log(` - AGENTS.md: skipped${agentTemplateResult.reason ? `: ${agentTemplateResult.reason}` : ''}`);
            }
            // stats plugin
            if (statsPluginResult.installed) {
              console.log(' - Stats plugin: installed');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
              console.log(' - Stats plugin: already in place');
            } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
              console.log(' - Stats plugin: skipped by user');
            } else if (statsPluginResult.skipped) {
              console.log(` - Stats plugin: skipped${statsPluginResult.reason ? `: ${statsPluginResult.reason}` : ''}`);
            }

            console.log('\nNote: `wl init` is idempotent and can safely be run again if any options need to be changed.');
            return;
          } catch (error) {
            output.error('Error: ' + (error as Error).message, { success: false, error: (error as Error).message });
            process.exit(1);
          }
        }
      }
      
      try {
        await initConfig(undefined, {
          projectName: normalizedOptions.projectName,
          prefix: normalizedOptions.prefix,
          autoExport: normalizedOptions.autoExport,
          autoSync: normalizedOptions.autoSync,
        } satisfies InitConfigOptions);
        const config = loadConfig();
        writeInitSemaphore(version);
        const initInfo = readInitSemaphore();
        
        if (isJsonMode) {
          const gitignoreResult = ensureGitignore({ silent: true });
          const hookResult = installPrePushHook({ silent: true });
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: true, action: normalizedOptions.agentsTemplateAction });
          output.json({
            success: true,
            message: 'Configuration initialized',
            config: {
              projectName: config?.projectName,
              prefix: config?.prefix
            },
            version: version,
            initializedAt: initInfo?.initializedAt,
            gitignore: gitignoreResult,
            gitHook: hookResult,
            agentTemplate: agentTemplateResult
          });
        }
        
        if (!isJsonMode) {
          console.log('\n' + chalk.blue('## Git Sync') + '\n');
          console.log('Syncing database...');
        }
        
        try {
          await performInitSync(dataPath, config?.prefix, isJsonMode);
        } catch (syncError) {
          if (isJsonMode) {
            const outputData: any = {
              success: true,
              message: 'Configuration initialized',
              config: {
                projectName: config?.projectName,
                prefix: config?.prefix
              },
              syncWarning: {
                message: 'Sync failed (this is OK for new projects without remote data)',
                error: (syncError as Error).message
              }
            };
            output.json(outputData);
          } else {
            console.log('\nSync failed (this is OK for new projects without remote data)');
            console.log(`  ${(syncError as Error).message}`);
          }
        }

          if (!isJsonMode) {
            console.log('\n' + chalk.blue('## Gitignore') + '\n');
            const gitignoreResult = ensureGitignore({ silent: false });
            if (gitignoreResult.updated) {
              console.log(`.gitignore updated at ${gitignoreResult.gitignorePath} (added ${gitignoreResult.added?.length || 0} entries)`);
            } else if (gitignoreResult.present) {
              console.log('.gitignore is already up-to-date');
            } else {
              if (gitignoreResult.reason) {
                console.log(`.gitignore not updated: ${gitignoreResult.reason}`);
              } else {
                console.log('.gitignore: no changes required');
              }
            }

          console.log('\n' + chalk.blue('## Git Hooks') + '\n');
            const hookResult = installPrePushHook({ silent: false });
            const postPullResult = installPostPullHooks({ silent: true });
            const committedHooksResult = installCommittedHooks({ silent: true });
            if (hookResult.present) {
              if (hookResult.hookPath) {
                console.log(`Git pre-push hook: installed at ${hookResult.hookPath}`);
              } else {
                console.log('Git pre-push hook: present');
              }
            } else {
              console.log('Git pre-push hook: not present');
            }
            if (!hookResult.installed && hookResult.reason && hookResult.reason !== 'hook already installed') {
              console.log(`\ngit pre-push hook not installed: ${hookResult.reason}`);
            }
            if (postPullResult && postPullResult.installed) {
              console.log(`Git post-pull hooks: installed at ${postPullResult.hookPaths?.join(', ')}`);
            } else if (postPullResult && postPullResult.skipped) {
              // ok
            } else if (postPullResult && postPullResult.reason) {
              console.log(`Git post-pull hooks: not installed: ${postPullResult.reason}`);
            }

            if (committedHooksResult && committedHooksResult.installed) {
              console.log(`Git committed hooks: written to ${committedHooksResult.dirPath}. To enable run: git config core.hooksPath ${DEFAULT_COMMITTED_HOOKS_DIR}`);
            }

          console.log('\n' + chalk.blue('## Agent Template') + '\n');
          const agentTemplateResult = await ensureAgentTemplateInstalled({ silent: false, action: normalizedOptions.agentsTemplateAction });
          // Offer workflow integration after AGENTS.md handling
          const workflowTemplatePath = locateWorkflowTemplate();
          if (workflowTemplatePath) {
            const projectRoot = resolveProjectRoot();
            const agentDestination = resolveAgentDestination(projectRoot);
            

            if (fs.existsSync(agentDestination)) {
              const agentContent = fs.readFileSync(agentDestination, 'utf-8');
              // If loader already present, note it and still offer to install WORKFLOW.md
                if (agentContent.includes('<!-- WORKFLOW: start -->')) {
                  // If loader present, report and do not prompt.
                  console.log('Workflow already inlined in AGENTS.md.');
                  // Report status of WORKFLOW.md (installed / exists but differs / missing) without prompting
                  try {
                    const projectRootCheck = resolveProjectRoot();
                    const wfDest = path.join(projectRootCheck, WORKFLOW_DESTINATION_FILENAME);
                    if (fs.existsSync(wfDest)) {
                      const existingWf = normalizeContent(fs.readFileSync(wfDest, 'utf-8'));
                      const templateWf = normalizeContent(fs.readFileSync(workflowTemplatePath, 'utf-8'));
                      if (existingWf.includes(templateWf)) {
                        // WORKFLOW.md already matches template — loader presence already communicates this intent, skip duplicate line
                      } else {
                        
                      }
                    } else {
                      
                    }
                  } catch (e) {
                    
                  }
                } else {
                // Loader missing: offer to insert loader and install WORKFLOW.md
                  const wantBoth = await promptWorkflowInstall('Would you like to inline the workflow into AGENTS.md? (y/N): ', normalizedOptions.workflowInline);
                  if (wantBoth) {
                    await ensureWorkflowTemplateInstalled({ silent: false, agentDestinationPath: agentDestination });
                    insertWorkflowLoaderIntoAgents(agentDestination);
                  } else {
                    // user skipped — no summary output
                  }
              }
            } else {
              // No AGENTS.md present: offer to install only WORKFLOW.md
                const wantWorkflow = await promptWorkflowInstall('No AGENTS.md found. Would you like to create AGENTS.md with the workflow inlined? (y/N): ', normalizedOptions.workflowInline);
                if (wantWorkflow) {
                  await ensureWorkflowTemplateInstalled({ silent: false });
                } else {
                  // user skipped — no summary output
                }
            }

            // We no longer print a workflowReport summary; helpers print output
          }

          if (!agentTemplateResult.installed && agentTemplateResult.reason === 'template already in place') {
            console.log('AGENTS.md already matches the Worklog template.');
          }
          if (!agentTemplateResult.installed && agentTemplateResult.reason && agentTemplateResult.reason !== 'template already in place') {
            console.log(`Note: AGENTS template not installed: ${agentTemplateResult.reason}`);
          }
          // Offer to install example stats plugin
          console.log('\n' + chalk.blue('## Install plugins') + '\n');
          const statsPluginResult = await ensureStatsPluginInstalled({ silent: false, overwrite: normalizedOptions.statsPluginOverwrite });
          if (statsPluginResult.installed) {
            console.log(`✓ Installed example stats plugin at ${statsPluginResult.destinationPath}`);
          } else if (statsPluginResult.skipped && statsPluginResult.reason === 'already in place') {
            console.log('Stats plugin already present.');
          } else if (statsPluginResult.skipped && statsPluginResult.reason === 'user declined') {
            console.log('Stats plugin installation skipped by user.');
          } else if (statsPluginResult.skipped && statsPluginResult.reason) {
            console.log(`Stats plugin: ${statsPluginResult.reason}`);
          }
        }
      } catch (error) {
        output.error('Error: ' + (error as Error).message, { success: false, error: (error as Error).message });
        process.exit(1);
      }
    });
}
