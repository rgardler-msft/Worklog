import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';

describe('CLI Issue Management Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  describe('create command', () => {
    it('should create a work item with required fields', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Test task"`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.id).toMatch(/^TEST-/);
      expect(result.workItem.title).toBe('Test task');
      expect(result.workItem.status).toBe('open');
      expect(result.workItem.priority).toBe('medium');
    });

    it('should create a work item with all optional fields', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Full task" -d "Description" -s in-progress -p high --tags "tag1,tag2" -a "john" --stage "dev"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Full task');
      expect(result.workItem.description).toBe('Description');
      expect(result.workItem.status).toBe('in-progress');
      expect(result.workItem.priority).toBe('high');
      expect(result.workItem.tags).toEqual(['tag1', 'tag2']);
      expect(result.workItem.assignee).toBe('john');
      expect(result.workItem.stage).toBe('dev');
    });
  });

  describe('update command', () => {
    let workItemId: string;

    beforeEach(async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Original title"`);
      const result = JSON.parse(stdout);
      workItemId = result.workItem.id;
    });

    it('should update a work item title', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${workItemId} -t "Updated title"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Updated title');
    });

    it('should update multiple fields', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json update ${workItemId} -t "Updated" -s completed -p high`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Updated');
      expect(result.workItem.status).toBe('completed');
      expect(result.workItem.priority).toBe('high');
    });
  });

  describe('delete command', () => {
    it('should delete a work item', async () => {
      const createResult = await execAsync(`tsx ${cliPath} --json create -t "To delete"`);
      const created = JSON.parse(createResult.stdout);
      const workItemId = created.workItem.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json delete ${workItemId}`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.deletedId).toBe(workItemId);

      try {
        await execAsync(`tsx ${cliPath} --json show ${workItemId}`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        if (error?.stderr) {
          const result = JSON.parse(error.stderr || '{}');
          expect(result.success).toBe(false);
        }
      }
    });
  });

  describe('comment commands', () => {
    let workItemId: string;

    beforeEach(async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Task with comments"`);
      const result = JSON.parse(stdout);
      workItemId = result.workItem.id;
    });

    it('should create a comment', async () => {
      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "John" --body "Test comment"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.comment.workItemId).toBe(workItemId);
      expect(result.comment.author).toBe('John');
      expect(result.comment.comment).toBe('Test comment');
    });

    it('should error when both --comment and --body are provided', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json comment create ${workItemId} -a "John" -c "Legacy" --body "New"`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || error.stdout || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot use both --comment and --body together.');
      }
    });

    it('should update a comment', async () => {
      const createResult = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "Alice" --body "Original"`
      );
      const created = JSON.parse(createResult.stdout);
      const commentId = created.comment.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment update ${commentId} -c "Updated comment"`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.comment.comment).toBe('Updated comment');
    });

    it('should delete a comment', async () => {
      const createResult = await execAsync(
        `tsx ${cliPath} --json comment create ${workItemId} -a "Alice" --body "To delete"`
      );
      const created = JSON.parse(createResult.stdout);
      const commentId = created.comment.id;

      const { stdout } = await execAsync(
        `tsx ${cliPath} --json comment delete ${commentId}`
      );

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.deletedId).toBe(commentId);
    });
  });

  describe('dep commands', () => {
    it('should add a dependency edge', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.edge.fromId).toBe(fromId);
      expect(result.edge.toId).toBe(toId);

      const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show ${fromId}`);
      const updated = JSON.parse(showStdout).workItem;
      expect(updated.status).toBe('blocked');
    });

    it('should remove a dependency edge', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep rm ${fromId} ${toId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.removed).toBe(true);
      expect(result.edge.fromId).toBe(fromId);
      expect(result.edge.toId).toBe(toId);

      const { stdout: showStdout } = await execAsync(`tsx ${cliPath} --json show ${fromId}`);
      const updated = JSON.parse(showStdout).workItem;
      expect(updated.status).toBe('open');
    });

    it('should fail when adding an existing dependency', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);

      try {
        await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Dependency already exists.');
      }
    });

    it('should error for missing ids', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json dep add TEST-NOTFOUND TEST-NOTFOUND-2`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(Array.isArray(result.errors)).toBe(true);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it('should list dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId}`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].id).toBe(toId);
      expect(result.outbound[0].direction).toBe('depends-on');
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].id).toBe(otherId);
      expect(result.inbound[0].direction).toBe('depended-on-by');
    });

    it('should list outbound-only dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId} --outgoing`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.outbound).toHaveLength(1);
      expect(result.outbound[0].id).toBe(toId);
      expect(result.inbound).toHaveLength(0);
    });

    it('should list inbound-only dependency edges', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const { stdout: toStdout } = await execAsync(`tsx ${cliPath} --json create -t "To"`);
      const { stdout: otherStdout } = await execAsync(`tsx ${cliPath} --json create -t "Other"`);
      const fromId = JSON.parse(fromStdout).workItem.id;
      const toId = JSON.parse(toStdout).workItem.id;
      const otherId = JSON.parse(otherStdout).workItem.id;

      await execAsync(`tsx ${cliPath} --json dep add ${fromId} ${toId}`);
      await execAsync(`tsx ${cliPath} --json dep add ${otherId} ${fromId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list ${fromId} --incoming`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.inbound).toHaveLength(1);
      expect(result.inbound[0].id).toBe(otherId);
      expect(result.outbound).toHaveLength(0);
    });

    it('should warn for missing ids and exit 0 for list', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json dep list TEST-NOTFOUND`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.inbound).toHaveLength(0);
      expect(result.outbound).toHaveLength(0);
    });

    it('should error when using incoming and outgoing together', async () => {
      const { stdout: fromStdout } = await execAsync(`tsx ${cliPath} --json create -t "From"`);
      const fromId = JSON.parse(fromStdout).workItem.id;

      try {
        await execAsync(`tsx ${cliPath} --json dep list ${fromId} --incoming --outgoing`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
        expect(result.error).toBe('Cannot use --incoming and --outgoing together.');
      }
    });
  });
});
