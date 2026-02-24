import { Command } from 'commander';
import { createPluginContext } from '../../src/cli-utils.js';
import * as path from 'path';

// Import built-in commands (same set as src/cli.ts)
import initCommand from '../../src/commands/init.js';
import statusCommand from '../../src/commands/status.js';
import createCommand from '../../src/commands/create.js';
import listCommand from '../../src/commands/list.js';
import showCommand from '../../src/commands/show.js';
import updateCommand from '../../src/commands/update.js';
import deleteCommand from '../../src/commands/delete.js';
import exportCommand from '../../src/commands/export.js';
import importCommand from '../../src/commands/import.js';
import nextCommand from '../../src/commands/next.js';
import inProgressCommand from '../../src/commands/in-progress.js';
import syncCommand from '../../src/commands/sync.js';
import githubCommand from '../../src/commands/github.js';
import commentCommand from '../../src/commands/comment.js';
import closeCommand from '../../src/commands/close.js';
import recentCommand from '../../src/commands/recent.js';
import pluginsCommand from '../../src/commands/plugins.js';
import tuiCommand from '../../src/commands/tui.js';
import migrateCommand from '../../src/commands/migrate.js';
import depCommand from '../../src/commands/dep.js';
import reSortCommand from '../../src/commands/re-sort.js';
import doctorCommand from '../../src/commands/doctor.js';
import unlockCommand from '../../src/commands/unlock.js';
import searchCommand from '../../src/commands/search.js';

const builtInCommands = [
  initCommand,
  statusCommand,
  createCommand,
  listCommand,
  showCommand,
  updateCommand,
  deleteCommand,
  exportCommand,
  importCommand,
  nextCommand,
  inProgressCommand,
  syncCommand,
  githubCommand,
  commentCommand,
  closeCommand,
  recentCommand,
  pluginsCommand,
  tuiCommand,
  migrateCommand,
  depCommand,
  reSortCommand,
  doctorCommand,
  unlockCommand,
  searchCommand,
];

function splitShellArgs(cmd: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const res: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1] !== undefined) res.push(m[1]);
    else if (m[2] !== undefined) res.push(m[2]);
    else if (m[3] !== undefined) res.push(m[3]);
  }
  return res;
}

export async function runInProcess(commandLine: string, timeoutMs: number = 15000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  // Extract args after the CLI path
  const tokens = splitShellArgs(commandLine);
  // find index of the script path (ends with src/cli.ts)
  const cliIndex = tokens.findIndex(t => t.endsWith(path.join('src', 'cli.ts')) || t.endsWith(path.join('dist', 'cli.js')));
  const args = cliIndex >= 0 ? tokens.slice(cliIndex + 1) : tokens;

  // Capture stdout/stderr
  const out: string[] = [];
  const err: string[] = [];
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExit = process.exit;
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleWarn = console.warn;
  const origConsoleInfo = console.info;
  const origArgv = process.argv;
  const argv = ['node', 'worklog', ...args];
  process.argv = argv;
  process.stdout.write = ((chunk: any, enc?: any, cb?: any) => {
    try {
      out.push(typeof chunk === 'string' ? chunk : chunk?.toString(enc || 'utf8') || String(chunk));
    } catch (e) {
      out.push(String(chunk));
    }
    if (typeof cb === 'function') cb();
    return true;
  }) as any;
  process.stderr.write = ((chunk: any, enc?: any, cb?: any) => {
    try {
      err.push(typeof chunk === 'string' ? chunk : chunk?.toString(enc || 'utf8') || String(chunk));
    } catch (e) {
      err.push(String(chunk));
    }
    if (typeof cb === 'function') cb();
    return true;
  }) as any;
  process.exit = ((code?: number) => { throw new Error(`__INPROC_EXIT__:${code ?? 0}`); }) as any;
  console.log = ((...args: any[]) => { out.push(`${args.map(a => String(a)).join(' ')}\n`); }) as any;
  console.error = ((...args: any[]) => { err.push(`${args.map(a => String(a)).join(' ')}\n`); }) as any;
  console.warn = ((...args: any[]) => { err.push(`${args.map(a => String(a)).join(' ')}\n`); }) as any;
  console.info = ((...args: any[]) => { out.push(`${args.map(a => String(a)).join(' ')}\n`); }) as any;

  // Track database instances created during this run so we can close them
  // before returning. On Windows, SQLite file locks prevent temp-dir cleanup
  // unless all connections are explicitly closed.
  const openDatabases: Array<{ close(): void }> = [];

  try {
    const program = new Command();
    // Configure global options to match src/cli.ts so --json/--verbose/etc are recognized
    program
      .name('worklog')
      .description('In-process test runner for Worklog')
      .version('0.0.0')
      .option('--json', 'Output in JSON format (machine-readable)')
      .option('--verbose', 'Show verbose output including debug messages')
      .option('-F, --format <format>', 'Human display format (choices: concise|normal|full|raw)')
      .option('-w, --watch [seconds]', 'Rerun the command every N seconds (default: 5)');

    const ctx = createPluginContext(program);
    // Wrap getDatabase to track instances for cleanup
    const origGetDatabase = ctx.utils.getDatabase;
    ctx.utils.getDatabase = (prefix?: string) => {
      const db = origGetDatabase(prefix);
      openDatabases.push(db);
      return db;
    };
    // Register built-in commands
    for (const r of builtInCommands) r(ctx);

     // Instrument command lifecycle so we can see which command starts/completes
     // when running in-process. Use origStderrWrite so test runner sees progress
     // even if process.stderr.write is captured.
     // Track the most recent action (name + opts) so timeouts can report what was running
     let lastActionName: string | null = null;
     let lastActionOpts: any = {};
     try {
       program.hook('preAction', (thisCommand: any, actionCommand: any) => {
        const name = actionCommand?.name?.() || thisCommand.name?.() || (thisCommand._name ?? '(unknown)');
        const opts = typeof actionCommand?.opts === 'function' ? actionCommand.opts() : (thisCommand.opts ? thisCommand.opts() : {});
        lastActionName = name;
        lastActionOpts = opts || {};
      });
      program.hook('postAction', (thisCommand: any, actionCommand: any) => {
        const name = actionCommand?.name?.() || thisCommand.name?.() || (thisCommand._name ?? '(unknown)');
        // clear last action after completion
        lastActionName = null;
        lastActionOpts = {};
      });
    } catch (e) {
      // commander may throw for unsupported hook API versions; ignore instrumentation
    }

    // Run command
      try {
        // Provide a full argv (node + script) and parse from 'node' so commander
        // treats the following entries as process argv (matching subprocess behaviour).
        const start = Date.now();

        // Reset any previously set process.exitCode so stale values from other
        // in-process runs don't leak into this invocation. Tests rely on
        // create/update commands returning exitCode=0 by default.
        // Reset any previously set process.exitCode so stale values from other
        // in-process runs don't leak into this invocation. Tests rely on
        // create/update commands returning exitCode=0 by default.
        process.exitCode = 0;

        // Run parse with a timeout so a hung command can be diagnosed instead of
        // silently blocking the test runner. Timeout is conservative (15s).
        try {
          await Promise.race([
            program.parseAsync(argv, { from: 'node' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('__INPROC_PARSE_TIMEOUT__')), timeoutMs)),
          ]);
        } catch (e: any) {
        if (e && e.message === '__INPROC_PARSE_TIMEOUT__') {
          // Dump diagnostics to original stderr so they appear in test logs immediately
          try {
            origStderrWrite?.call(process.stderr, `INPROC_DEBUG: PARSE_TIMEOUT after ${timeoutMs}ms\n`);
            origStderrWrite?.call(process.stderr, `INPROC_DEBUG: captured stdout:\n${out.join('')}\n`);
            origStderrWrite?.call(process.stderr, `INPROC_DEBUG: captured stderr:\n${err.join('')}\n`);
            origStderrWrite?.call(process.stderr, `INPROC_DEBUG: program.opts=${JSON.stringify(program.opts())}\n`);
            origStderrWrite?.call(process.stderr, `INPROC_DEBUG: lastActionName=${String(lastActionName)} lastActionOpts=${JSON.stringify(lastActionOpts)}\n`);
          } catch (inner) {
            // ignore
          }
          err.push(`PARSE_TIMEOUT:${timeoutMs}`);
          return { stdout: out.join(''), stderr: err.join(''), exitCode: 124 };
        }
        throw e;
      }

      const end = Date.now();
      // Respect any process.exitCode set by command handlers so in-process
      // runs mirror spawn behaviour. If a command set process.exitCode = 1
      // we should surface that to the caller (execAsync) so tests can treat
      // the invocation as failed.
       const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
       return { stdout: out.join(''), stderr: err.join(''), exitCode };
    } catch (e: any) {
      if (e && typeof e.message === 'string' && e.message.startsWith('__INPROC_EXIT__')) {
        const code = Number(e.message.split(':')[1]) || 0;
        return { stdout: out.join(''), stderr: err.join(''), exitCode: code };
      }
      throw e;
    }
  } finally {
    // Close all database connections opened during this run to release
    // Windows file locks before tests attempt temp-dir cleanup.
    for (const db of openDatabases) {
      try { db.close(); } catch (_) { /* ignore */ }
    }
    	process.stdout.write = origStdoutWrite;
    	process.stderr.write = origStderrWrite;
    	process.exit = origExit;
    	console.log = origConsoleLog;
    	console.error = origConsoleError;
    	console.warn = origConsoleWarn;
    	console.info = origConsoleInfo;
    	process.argv = origArgv;
    	// No instrumentation present; nothing else to restore for exitCode.
  }
}
