import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir
} from './cli-helpers.js';

describe('CLI Initialization Check Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    fs.rmSync('.worklog', { recursive: true, force: true });
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  it('should fail create command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json create -t "Test"`);
      throw new Error('Expected create command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail list command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json list`);
      throw new Error('Expected list command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail show command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json show TEST-1`);
      throw new Error('Expected show command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail update command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json update TEST-1 -t "Updated"`);
      throw new Error('Expected update command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail delete command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json delete TEST-1`);
      throw new Error('Expected delete command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail export command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json export -f /tmp/test.jsonl`);
      throw new Error('Expected export command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail import command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json import -f /tmp/test.jsonl`);
      throw new Error('Expected import command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail sync command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json sync --dry-run`);
      throw new Error('Expected sync command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail next command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json next`);
      throw new Error('Expected next command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail comment create command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment create TEST-1 -a "Author" --body "Comment"`);
      throw new Error('Expected comment create command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail comment list command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment list TEST-1`);
      throw new Error('Expected comment list command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail comment show command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment show C-1`);
      throw new Error('Expected comment show command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail comment update command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment update C-1 -c "Updated"`);
      throw new Error('Expected comment update command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });

  it('should fail comment delete command when not initialized', async () => {
    try {
      await execAsync(`tsx ${cliPath} --json comment delete C-1`);
      throw new Error('Expected comment delete command to fail, but it succeeded');
    } catch (error: any) {
      const result = JSON.parse(error.stdout || '{}');
      expect(result.success).toBe(false);
      expect(result.initialized).toBe(false);
      expect(result.error).toContain('not initialized');
    }
  });
});
