/**
 * Plugin loader - discovers and loads CLI command plugins
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { PluginContext, PluginInfo, PluginLoaderOptions, PluginModule } from './plugin-types.js';
import { resolveWorklogDir } from './worklog-paths.js';
import { Logger } from './logger.js';

/**
 * Get the default plugin directory path
 * @returns Absolute path to the plugin directory
 */
export function getDefaultPluginDir(): string {
  return path.join(resolveWorklogDir(), 'plugins');
}

/**
 * Resolve the plugin directory based on config and environment
 * Priority: WORKLOG_PLUGIN_DIR env var > provided option > default
 */
export function resolvePluginDir(options?: PluginLoaderOptions): string {
  // Check environment variable first
  if (process.env.WORKLOG_PLUGIN_DIR) {
    return path.resolve(process.env.WORKLOG_PLUGIN_DIR);
  }
  
  // Use provided option
  if (options?.pluginDir) {
    return path.resolve(options.pluginDir);
  }
  
  // Fall back to default
  return getDefaultPluginDir();
}

/**
 * Discover plugin files in the plugin directory
 * Only includes .js and .mjs files, excludes .d.ts, .map, etc.
 */
export function discoverPlugins(pluginDir: string): string[] {
  // Check if plugin directory exists
  if (!fs.existsSync(pluginDir)) {
    return [];
  }
  
  // Read directory
  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  
  // Filter to only .js and .mjs files (excluding .d.ts, .map, etc.)
  const plugins = entries
    .filter(entry => {
      if (!entry.isFile()) return false;
      const name = entry.name;
      // Must end with .js or .mjs, but not .d.ts
      return (name.endsWith('.js') || name.endsWith('.mjs')) && !name.endsWith('.d.ts');
    })
    .map(entry => path.join(pluginDir, entry.name))
    .sort(); // Deterministic lexicographic order
  
  return plugins;
}

/**
 * Load a single plugin file
 * @returns Plugin info with load status
 */
export async function loadPlugin(
  pluginPath: string,
  ctx: PluginContext,
  verbose: boolean = false
): Promise<PluginInfo> {
  const name = path.basename(pluginPath);
  const logger = new Logger({ verbose, jsonMode: false });
  
  try {
    logger.debug(`Loading plugin: ${name}`);
    
    // Convert file path to file URL for ESM import
    const fileUrl = pathToFileURL(pluginPath).href;
    
    // Dynamic import
    const module = await import(fileUrl) as PluginModule;
    
    // Check for default export
    if (!module.default || typeof module.default !== 'function') {
      throw new Error('Plugin must export a default register function');
    }
    
    // Call the register function
    await module.default(ctx);
    
    logger.debug(`✓ Loaded plugin: ${name}`);
    
    return {
      name,
      path: pluginPath,
      loaded: true
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (verbose) {
      console.error(`✗ Failed to load plugin ${name}: ${errorMessage}`);
    }
    
    return {
      name,
      path: pluginPath,
      loaded: false,
      error: errorMessage
    };
  }
}

/**
 * Load all plugins from the plugin directory
 * @returns Array of plugin info objects
 */
export async function loadPlugins(
  ctx: PluginContext,
  options?: PluginLoaderOptions
): Promise<PluginInfo[]> {
  const verbose = options?.verbose || false;
  const logger = new Logger({ verbose, jsonMode: false });
  const pluginDir = resolvePluginDir(options);
  
  logger.debug(`Plugin directory: ${pluginDir}`);
  
  // Discover plugin files
  const pluginPaths = discoverPlugins(pluginDir);
  
  if (pluginPaths.length === 0) {
    logger.debug('No plugins found');
    return [];
  }
  
  logger.debug(`Found ${pluginPaths.length} plugin(s)`);
  
  // Load plugins sequentially to maintain deterministic order
  const results: PluginInfo[] = [];
  for (const pluginPath of pluginPaths) {
    const result = await loadPlugin(pluginPath, ctx, verbose);
    results.push(result);
  }
  
  return results;
}

/**
 * Check if a command name is already registered
 */
export function hasCommand(program: any, commandName: string): boolean {
  const commands = program.commands || [];
  return commands.some((cmd: any) => cmd.name() === commandName);
}
