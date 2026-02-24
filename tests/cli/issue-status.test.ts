import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cliPath,
  execAsync,
  enterTempDir,
  leaveTempDir,
  seedWorkItems,
  writeConfig,
  writeInitSemaphore
} from './cli-helpers.js';

describe('CLI Issue Status Tests', () => {
  let tempState: { tempDir: string; originalCwd: string };

  beforeEach(() => {
    tempState = enterTempDir();
    writeConfig(tempState.tempDir, 'Test Project', 'TEST');
    writeInitSemaphore(tempState.tempDir, '1.0.0');
  });

  afterEach(() => {
    leaveTempDir(tempState);
  });

  describe('list command', () => {
    beforeEach(() => {
      seedWorkItems(tempState.tempDir, [
        { title: 'Task 1', status: 'open', priority: 'high', needsProducerReview: true },
        { title: 'Task 2', status: 'in-progress', priority: 'medium' },
        { title: 'Task 3', status: 'completed', priority: 'low', needsProducerReview: true },
      ]);
    });

    it('should list all work items', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(3);
    });

    it('should filter by status', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list -s open`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(1);
      expect(result.workItems[0].status).toBe('open');
    });

    it('should filter by priority', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list -p high`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(1);
      expect(result.workItems[0].priority).toBe('high');
    });

    it('should filter by multiple criteria', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list -s open -p high`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(1);
      expect(result.workItems[0].status).toBe('open');
      expect(result.workItems[0].priority).toBe('high');
    });

    it('should filter by id search term', async () => {
      const { stdout: createStdout } = await execAsync(`tsx ${cliPath} --json create -t "Searchable"`);
      const created = JSON.parse(createStdout).workItem;

      const { stdout } = await execAsync(`tsx ${cliPath} --json list ${created.id}`);
      const result = JSON.parse(stdout);

      const ids = result.workItems.map((item: any) => item.id);
      expect(result.success).toBe(true);
      expect(ids).toContain(created.id);
    });

    it('should filter by parent id', async () => {
      const parentResult = await execAsync(`tsx ${cliPath} --json create -t "Parent"`);
      const parent = JSON.parse(parentResult.stdout).workItem;

      const child1 = await execAsync(`tsx ${cliPath} --json create -t "Child 1" -P ${parent.id}`);
      const child2 = await execAsync(`tsx ${cliPath} --json create -t "Child 2" -P ${parent.id}`);
      const unrelated = await execAsync(`tsx ${cliPath} --json create -t "Other"`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json list --parent ${parent.id}`);
      const result = JSON.parse(stdout);

      const child1Id = JSON.parse(child1.stdout).workItem.id;
      const child2Id = JSON.parse(child2.stdout).workItem.id;
      const unrelatedId = JSON.parse(unrelated.stdout).workItem.id;

      const listedIds = result.workItems.map((item: any) => item.id);
      expect(result.success).toBe(true);
      expect(listedIds).toContain(child1Id);
      expect(listedIds).toContain(child2Id);
      expect(listedIds).not.toContain(parent.id);
      expect(listedIds).not.toContain(unrelatedId);
    });

    it('should filter by needs-producer-review true', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list --needs-producer-review true`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(2);
      result.workItems.forEach((item: any) => expect(item.needsProducerReview).toBe(true));
    });

    it('should default needs-producer-review to true when value omitted', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list --needs-producer-review`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(2);
      result.workItems.forEach((item: any) => expect(item.needsProducerReview).toBe(true));
    });

    it('should filter by needs-producer-review false', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json list --needs-producer-review false`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItems).toHaveLength(1);
      result.workItems.forEach((item: any) => expect(item.needsProducerReview).not.toBe(true));
    });

    it('should error for invalid parent id', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json list --parent TEST-NOTFOUND`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
      }
    });
  });

  describe('show command', () => {
    let workItemId: string;

    beforeEach(async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json create -t "Test task"`);
      const result = JSON.parse(stdout);
      workItemId = result.workItem.id;
    });

    it('should show a work item by ID', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json show ${workItemId}`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.id).toBe(workItemId);
      expect(result.workItem.title).toBe('Test task');
    });

    it('should show children when -c flag is used', async () => {
      await execAsync(`tsx ${cliPath} create -t "Child task" -P ${workItemId}`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json show ${workItemId} -c`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.children).toBeDefined();
      expect(result.children).toHaveLength(1);
      expect(result.children[0].title).toBe('Child task');
    });

    it('should return error for non-existent ID', async () => {
      try {
        await execAsync(`tsx ${cliPath} --json show TEST-NONEXISTENT`);
        expect.fail('Should have thrown an error');
      } catch (error: any) {
        const result = JSON.parse(error.stderr || '{}');
        expect(result.success).toBe(false);
      }
    });

    it('should display work item in tree format in non-JSON mode', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} show ${workItemId}`);

      expect(stdout).toContain('Test task');
      expect(stdout).toContain(workItemId);
      expect(stdout).toContain('└──');
    });

    it('should display work item with children in tree format in non-JSON mode', async () => {
      const { stdout: child1Stdout } = await execAsync(`tsx ${cliPath} --json create -t "Child 1" -P ${workItemId} -p high`);
      const child1 = JSON.parse(child1Stdout);
      await execAsync(`tsx ${cliPath} create -t "Child 2" -P ${workItemId} -p low`);

      await execAsync(`tsx ${cliPath} create -t "Grandchild" -P ${child1.workItem.id}`);

      const { stdout } = await execAsync(`tsx ${cliPath} show ${workItemId} --children`);

      expect(stdout).toContain('Test task');
      expect(stdout).toContain('Child 1');
      expect(stdout).toContain('Child 2');
      expect(stdout).toContain('Grandchild');
      expect(stdout).toContain('├──');
      expect(stdout).toContain('│');
    });
  });

  describe('next command', () => {
    it('should find the next work item when items exist', async () => {
      await execAsync(`tsx ${cliPath} create -t "Task 1" -s open -p low`);
      await execAsync(`tsx ${cliPath} create -t "Task 2" -s open -p high`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeDefined();
      expect(result.workItem.title).toBe('Task 1');
    });

    it('should return null when no work items exist', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem).toBeNull();
    });

    it('should filter by assignee', async () => {
      await execAsync(`tsx ${cliPath} create -t "John task" -p high -a "john"`);
      await execAsync(`tsx ${cliPath} create -t "Jane task" -p critical -a "jane"`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next -a john`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('John task');
      expect(result.workItem.assignee).toBe('john');
    });

    it('should filter by search term in title', async () => {
      await execAsync(`tsx ${cliPath} create -t "Regular task" -p critical`);
      await execAsync(`tsx ${cliPath} create -t "Bug fix needed" -p low`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next -s bug`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Bug fix needed');
    });

    it('should filter by search term in description', async () => {
      await execAsync(`tsx ${cliPath} create -t "Task 1" -d "Some work" -p critical`);
      await execAsync(`tsx ${cliPath} create -t "Task 2" -d "Authentication issue" -p low`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next -s authentication`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe('Task 2');
    });

    it('should prioritize critical open items over lower-priority in-progress items', async () => {
      const { stdout: openStdout } = await execAsync(`tsx ${cliPath} --json create -t "Open task" -s open -p critical`);
      const openResult = JSON.parse(openStdout);
      const openId = openResult.workItem.id;

      const { stdout: inProgressStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "In progress task" -s in-progress --stage in_progress -p low`
      );
      const inProgressResult = JSON.parse(inProgressStdout);
      const inProgressId = inProgressResult.workItem.id;

      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      // New selection logic favors the critical open item over a lower-priority in-progress item
      expect(result.workItem.id).toBe(openId);
    });

    it('should skip completed items', async () => {
      await execAsync(`tsx ${cliPath} create -t "Completed task" -s completed --stage done -p critical`);
      const { stdout: openStdout } = await execAsync(`tsx ${cliPath} --json create -t "Open task" -s open -p low`);
      const openResult = JSON.parse(openStdout);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.workItem.title).toBe(openResult.workItem.title);
    });

    it('should include a reason in the result', async () => {
      await execAsync(`tsx ${cliPath} create -t "Task 1" -s open -p high`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe('string');
    });

    it('should return unique items and note when fewer are available', async () => {
      await execAsync(`tsx ${cliPath} create -t "Only task" -s open -p high`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json next -n 3`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.requested).toBe(3);
      expect(result.count).toBe(1);
      expect(result.note).toContain('Only 1 of 3 requested work item');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].workItem).toBeTruthy();
    });
  });

  describe('in-progress command', () => {
    it('should list in-progress work items in JSON mode', async () => {
      await execAsync(`tsx ${cliPath} create -t "Open task" -s open`);
      const { stdout: ip1Stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "In progress 1" -s in-progress --stage in_progress -p high`
      );
      const { stdout: ip2Stdout } = await execAsync(
        `tsx ${cliPath} --json create -t "In progress 2" -s in-progress --stage in_progress -p medium`
      );
      await execAsync(`tsx ${cliPath} create -t "Completed task" -s completed --stage done`);

      const ip1 = JSON.parse(ip1Stdout);
      const ip2 = JSON.parse(ip2Stdout);

      const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);
      expect(result.workItems).toHaveLength(2);

      const ids = result.workItems.map((item: any) => item.id);
      expect(ids).toContain(ip1.workItem.id);
      expect(ids).toContain(ip2.workItem.id);
    });

    it('should return empty list when no in-progress items exist', async () => {
      await execAsync(`tsx ${cliPath} create -t "Open task" -s open`);
      await execAsync(`tsx ${cliPath} create -t "Completed task" -s completed --stage done`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.count).toBe(0);
      expect(result.workItems).toHaveLength(0);
    });

    it('should display in-progress items with parent-child relationships', async () => {
      const { stdout: parentStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Parent task" -s in-progress --stage in_progress -p high`
      );
      const parent = JSON.parse(parentStdout);

      await execAsync(
        `tsx ${cliPath} --json create -t "Child task" -s in-progress --stage in_progress -p medium -P ${parent.workItem.id}`
      );

      const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.count).toBe(2);

      const childItem = result.workItems.find((item: any) => item.title === 'Child task');
      expect(childItem).toBeDefined();
      expect(childItem.parentId).toBe(parent.workItem.id);
    });

    it('should display human-readable output in non-JSON mode', async () => {
      await execAsync(`tsx ${cliPath} create -t "In progress task" -s in-progress --stage in_progress -p high`);

      const { stdout } = await execAsync(`tsx ${cliPath} in-progress`);

      expect(stdout).toContain('Found 1 in-progress work item');
      expect(stdout).toContain('In progress task');
    });

    it('should show no items message when list is empty in non-JSON mode', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} in-progress`);

      expect(stdout).toContain('No in-progress work items found');
    });

    it('should filter by assignee', async () => {
      await execAsync(`tsx ${cliPath} --json create -t "Alice task" -s in-progress --stage in_progress -a "alice"`);
      await execAsync(`tsx ${cliPath} --json create -t "Bob task" -s in-progress --stage in_progress -a "bob"`);
      await execAsync(`tsx ${cliPath} --json create -t "Unassigned task" -s in-progress --stage in_progress`);

      const { stdout } = await execAsync(`tsx ${cliPath} --json in-progress --assignee alice`);

      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.workItems[0].title).toBe('Alice task');
      expect(result.workItems[0].assignee).toBe('alice');
    });

    it('should show output in new format Title - ID', async () => {
      const { stdout: createStdout } = await execAsync(
        `tsx ${cliPath} --json create -t "Test Task" -s in-progress --stage in_progress`
      );
      const created = JSON.parse(createStdout);
      const itemId = created.workItem.id;

      const { stdout } = await execAsync(`tsx ${cliPath} in-progress`);

      expect(stdout).toContain('Test Task');
      expect(stdout).toContain(`- ${itemId}`);
      expect(stdout).not.toContain(`(${itemId})`);
    });
  });

  describe('search command with new filter flags', () => {
    beforeEach(async () => {
      await execAsync(`tsx ${cliPath} create -t "Search high alice bug" -p high --assignee alice --issue-type bug --stage in_progress`);
      await execAsync(`tsx ${cliPath} create -t "Search low bob feature" -p low --assignee bob --issue-type feature --stage idea`);
      await execAsync(`tsx ${cliPath} create -t "Search high bob task" -p high --assignee bob --issue-type task --stage in_progress`);
    });

    it('should filter search results by --priority', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "search" --priority high`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(2);
    });

    it('should filter search results by --assignee', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "search" --assignee alice`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(1);
    });

    it('should filter search results by --issue-type', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "search" --issue-type bug`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(1);
    });

    it('should filter search results by --stage', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "search" --stage in_progress`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(2);
    });

    it('should combine --priority and --assignee', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} --json search "search" --priority high --assignee bob`);
      const result = JSON.parse(stdout);
      expect(result.success).toBe(true);
      expect(result.results.length).toBe(1);
    });

    it('should output human-readable format without --json', async () => {
      const { stdout } = await execAsync(`tsx ${cliPath} search "search" --priority high`);
      // Human-readable output should contain the search query echo
      expect(stdout).toContain('search');
    });
  });
});
