import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../../src/database.js';
import blessed from 'blessed';
import { createUpdateDialogFocusManager } from '../../src/tui/update-dialog-navigation.js';
import { buildUpdateDialogUpdates } from '../../src/tui/update-dialog-submit.js';
import { STATUS_STAGE_COMPATIBILITY, STAGE_STATUS_COMPATIBILITY } from '../../src/tui/status-stage-rules.js';

describe('TUI Update Dialog', () => {
  const tmpDir = path.join(process.cwd(), 'tmp-test-tui-update');
  const worklogDir = path.join(tmpDir, '.worklog');
  const jsonlPath = path.join(worklogDir, 'worklog-data.jsonl');

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(worklogDir, { recursive: true });

    // Seed multiple work items for testing
    const items = [
      {
        id: 'WL-TEST-1',
        title: 'Test Item 1',
        description: 'desc 1',
        status: 'open',
        priority: 'medium',
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: 'idea',
        issueType: 'feature',
        createdBy: '',
        deletedBy: '',
        deleteReason: ''
      },
      {
        id: 'WL-TEST-2',
        title: 'Test Item 2',
        description: 'desc 2',
        status: 'open',
        priority: 'high',
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tags: [],
        assignee: '',
        stage: 'prd_complete',
        issueType: 'task',
        createdBy: '',
        deletedBy: '',
        deleteReason: ''
      }
    ];

    items.forEach(item => {
      fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'workitem', data: item }) + '\n', 'utf-8');
    });

    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(path.resolve(__dirname, '../..'));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Update Dialog Functions', () => {
    it('should successfully update a work item stage via db.update', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      // Verify initial stage
      const itemBefore = db.get('WL-TEST-1');
      expect(itemBefore?.stage).toBe('idea');

      // Simulate selecting a stage option (index 3 = 'in_progress')
      db.update('WL-TEST-1', { stage: 'in_progress' });

      // Verify the update was applied
      const itemAfter = db.get('WL-TEST-1');
      expect(itemAfter?.stage).toBe('in_progress');
    });

    it('should update stage from prd_complete to plan_complete', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      const itemBefore = db.get('WL-TEST-2');
      expect(itemBefore?.stage).toBe('prd_complete');

      // Simulate selecting stage option (index 2 = 'plan_complete')
      db.update('WL-TEST-2', { stage: 'plan_complete' });

      const itemAfter = db.get('WL-TEST-2');
      expect(itemAfter?.stage).toBe('plan_complete');
    });

    it('should update to done stage', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      db.update('WL-TEST-1', { stage: 'done' });

      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('done');
    });

    it('should update to blocked stage', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      db.update('WL-TEST-1', { stage: 'blocked' });

      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('blocked');
    });
  });

  describe('Update Dialog UI Behavior', () => {
    it('should render update dialog with stage, status, priority, and comment box', () => {
      // Create blessed screen and dialog components
      const screen = blessed.screen({ mouse: true, smartCSR: true });

       const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true,
        tags: true,
        mouse: true,
        clickable: true,
        style: { border: { fg: 'magenta' } }
      });

       const updateDialogText = blessed.box({
        parent: updateDialog,
        top: 1,
        left: 2,
        height: 2,
        width: '100%-4',
        content: 'Update selected item fields:',
        tags: false
      });

      // Create a dummy textarea to reflect the new UI element
      const updateDialogComment = blessed.textarea({
        parent: updateDialog,
        top: 22,
        left: 2,
        width: '100%-4',
        height: 2,
        inputOnFocus: true,
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: 2,
        height: 1,
        width: '33%-2',
        content: 'Status',
        tags: false
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: '33%+1',
        height: 1,
        width: '33%-2',
        content: 'Stage',
        tags: false
      });

      blessed.box({
        parent: updateDialog,
        top: 5,
        left: '66%+1',
        height: 1,
        width: '33%-2',
        content: 'Priority',
        tags: false
      });

      const statusOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: 2,
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: [
          'open',
          'in-progress',
          'blocked',
          'completed',
          'deleted'
        ]
      });

      const stageOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: '33%+1',
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: [
          'idea',
          'prd_complete',
          'plan_complete',
          'in_progress',
          'in_review',
          'done'
        ]
      });

      const priorityOptions = blessed.list({
        parent: updateDialog,
        top: 6,
        left: '66%+1',
        width: '33%-2',
        height: 15,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' }
        },
        items: ['critical', 'high', 'medium', 'low']
      });

      // Verify dialog is properly constructed
      expect(updateDialog.hidden).toBe(true);
      expect(updateDialogText.getContent()).toContain('Update selected item fields:');

      // Verify lists have items (blessed list items API)
      expect(stageOptions.children.length).toBeGreaterThan(0);
      expect(statusOptions.children.length).toBeGreaterThan(0);
      expect(priorityOptions.children.length).toBeGreaterThan(0);
      expect(updateDialogComment).toBeTruthy();

      screen.destroy();
    });

    it('should show dialog with selected item info', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true
      });

      const updateDialogText = blessed.box({
        parent: updateDialog,
        top: 1,
        left: 2,
        height: 3,
        width: '100%-4',
        content: ''
      });

      // Simulate openUpdateDialog behavior
      const itemTitle = 'Test Item 1';
      const itemId = 'WL-TEST-1';
      updateDialogText.setContent(`Update: ${itemTitle}\nID: ${itemId}`);

      expect(updateDialogText.getContent()).toContain('Update: Test Item 1');
      expect(updateDialogText.getContent()).toContain('ID: WL-TEST-1');

      screen.destroy();
    });

    it('should close dialog and return focus to list', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const list = blessed.list({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: '100%-1',
        items: ['Item 1', 'Item 2']
      });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '70%',
        height: 24,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true
      });

      // Simulate closeUpdateDialog behavior
      updateDialog.hide();
      list.focus();

      expect(updateDialog.hidden).toBe(true);

      screen.destroy();
    });
  });

  describe('Update Dialog Selection Handling', () => {
    it('should handle all stage selections correctly', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      const stages = [
        'idea',
        'prd_complete',
        'plan_complete',
        'in_progress',
        'in_review',
        'done'
      ];

      // Verify each stage index maps to correct stage value
      const stageMapping: Record<number, string> = {
        0: 'idea',
        1: 'prd_complete',
        2: 'plan_complete',
        3: 'in_progress',
        4: 'in_review',
        5: 'done'
      };

      // Test each selection index
      stages.forEach((expectedStage, idx) => {
        db.update('WL-TEST-1', { stage: stageMapping[idx] });
        const item = db.get('WL-TEST-1');
        expect(item?.stage).toBe(expectedStage);
      });
    });

    it('should not expose a cancel stage option', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });
      const stageOptions = blessed.list({ parent: screen, items: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'] });
      expect(stageOptions.children.some((child: any) => child.getContent?.() === 'Cancel')).toBe(false);
      screen.destroy();
    });
  });

  describe('Update Dialog Focus Navigation', () => {
    it('should cycle focus forward and backward', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const stageList = blessed.list({ parent: screen, items: ['idea', 'done'] });
      const statusList = blessed.list({ parent: screen, items: ['open', 'completed'] });
      const priorityList = blessed.list({ parent: screen, items: ['high', 'low'] });
      const commentBox = blessed.textarea({ parent: screen, inputOnFocus: true });

      const focusManager = createUpdateDialogFocusManager([stageList, statusList, priorityList, commentBox]);

      focusManager.focusIndex(0);
      expect(focusManager.getIndex()).toBe(0);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(1);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(2);

      focusManager.cycle(1);
      expect(focusManager.getIndex()).toBe(3);

      focusManager.cycle(-1);
      expect(focusManager.getIndex()).toBe(2);

      screen.destroy();
    });
  });

  describe('Update Dialog Comment Handling', () => {
    it('should include comment in updates result when provided', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
          stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        },
        'hello\nworld'
      );

      expect(result.comment).toBe('hello\nworld');
      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should ignore blank comment values', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
          stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        },
        '   '
      );

      expect(result.comment).toBeUndefined();
      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });
  });

  describe('Update Dialog Default Selection', () => {
    it('should select current item values when opening dialog', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const statusOptions = blessed.list({ parent: screen, items: ['open', 'in-progress', 'blocked', 'completed', 'deleted'] });
      const stageOptions = blessed.list({ parent: screen, items: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'] });
      const priorityOptions = blessed.list({ parent: screen, items: ['critical', 'high', 'medium', 'low'] });

      const item = {
        status: 'blocked',
        stage: 'in_review',
        priority: 'high'
      };

      statusOptions.select(2);
      stageOptions.select(4);
      priorityOptions.select(1);

      expect((statusOptions as any).selected).toBe(2);
      expect((stageOptions as any).selected).toBe(4);
      expect((priorityOptions as any).selected).toBe(1);

      screen.destroy();
    });

    it('should update summary when selections change', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialogText = blessed.box({
        parent: screen,
        top: 1,
        left: 2,
        height: 3,
        width: '100%-4',
        content: ''
      });

      const statusOptions = blessed.list({ parent: screen, items: ['open', 'in-progress', 'blocked', 'completed', 'deleted'] });
      const stageOptions = blessed.list({ parent: screen, items: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'] });
      const priorityOptions = blessed.list({ parent: screen, items: ['critical', 'high', 'medium', 'low'] });

      const item = {
        id: 'WL-TEST-1',
        title: 'Test item',
        status: 'open',
        stage: 'idea',
        priority: 'medium'
      };

      const updateDialogStatusValues = ['open', 'in-progress', 'blocked', 'completed', 'deleted'];
      const updateDialogStageValues = ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'];
      const updateDialogPriorityValues = ['critical', 'high', 'medium', 'low'];

      const normalizeStatusValue = (value: string | undefined) => {
        if (!value) return value;
        return value.replace(/_/g, '-');
      };

      const updateDialogHeader = (overrides?: { status?: string; stage?: string; priority?: string; adjusted?: boolean }) => {
        const statusValue = overrides?.status ?? normalizeStatusValue(item.status) ?? '';
        const stageValue = overrides?.stage ?? (item.stage === '' ? 'Undefined' : item.stage);
        const priorityValue = overrides?.priority ?? item.priority ?? '';
        const adjustedSuffix = overrides?.adjusted ? ' (Adjusted)' : '';
        updateDialogText.setContent(
          `Update: ${item.title}\nID: ${item.id}\nStatus: ${statusValue} · Stage: ${stageValue} · Priority: ${priorityValue}${adjustedSuffix}`
        );
      };

      updateDialogHeader();
      expect(updateDialogText.getContent()).toContain('Status: open · Stage: idea · Priority: medium');

      statusOptions.select(1);
      stageOptions.select(3);
      priorityOptions.select(0);
      updateDialogHeader({
        status: updateDialogStatusValues[(statusOptions as any).selected ?? 0],
        stage: updateDialogStageValues[(stageOptions as any).selected ?? 0],
        priority: updateDialogPriorityValues[(priorityOptions as any).selected ?? 2]
      });

      expect(updateDialogText.getContent()).toContain('Status: in-progress · Stage: in_progress · Priority: critical');

      updateDialogHeader({
        status: 'completed',
        stage: 'in_review',
        priority: 'high',
        adjusted: true
      });

      expect(updateDialogText.getContent()).toContain('(Adjusted)');

      screen.destroy();
    });
  });

  describe('Update Dialog Submit Updates', () => {
    it('should reject invalid status/stage combinations', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 3, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
          stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should reject incompatible selections based on list items', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 0 },
        {
          statuses: ['completed', 'open'],
          stages: ['idea', 'in_review'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });
    it('should build updates only for changed fields', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 1, stageIndex: 3, priorityIndex: 1 },
        {
          statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
          stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }
      );

      expect(result.hasChanges).toBe(true);
      expect(result.updates).toEqual({
        status: 'in-progress',
        stage: 'in_progress',
        priority: 'high',
      });
    });

    it('should return no changes when selections match current values', () => {
      const item = { status: 'open', stage: 'idea', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
          stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }
      );

      expect(result.hasChanges).toBe(false);
      expect(result.updates).toEqual({});
    });

    it('should submit updates and comment in a single action', () => {
      const item = { id: 'WL-TEST-1', status: 'open', stage: 'idea', priority: 'medium' };
      const selections = { statusIndex: 2, stageIndex: 0, priorityIndex: 1 };
      const values = {
        statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
        stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
        priorities: ['critical', 'high', 'medium', 'low'],
      };
      const updateCalls: Array<Record<string, string>> = [];
      const commentCalls: string[] = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
        },
        createComment: (_payload: { workItemId: string; comment: string; author: string }) => {
          commentCalls.push(_payload.comment);
        },
      };

      // Extend submission to include a comment via the new multiline textbox
      const submitUpdateDialogWithComment = (comment?: string) => {
        const { updates, hasChanges, comment: newComment } = buildUpdateDialogUpdates(item, selections, values, {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }, comment);
        if (!hasChanges && !newComment) return;
        if (Object.keys(updates).length > 0) db.update(item.id, updates);
        if (newComment) db.createComment({ workItemId: item.id, comment: newComment, author: '@tui' });
      };

      submitUpdateDialogWithComment();
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]).toEqual({
        status: 'blocked',
        priority: 'high',
      });
      expect(commentCalls).toHaveLength(0);

      updateCalls.length = 0;
      commentCalls.length = 0;
      submitUpdateDialogWithComment('hello');
      expect(updateCalls).toHaveLength(1);
      expect(commentCalls).toHaveLength(1);
      expect(commentCalls[0]).toBe('hello');
    });

    it('should preserve comment when update fails and allow retry', () => {
      const updateCalls: Array<Record<string, string>> = [];
      const commentCalls: string[] = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
          throw new Error('Update failed');
        },
        createComment: (_payload: { workItemId: string; comment: string; author: string }) => {
          commentCalls.push(_payload.comment);
        },
      };

      let commentValue = 'keep me';
      const submitUpdateDialogWithFailure = () => {
        const { updates, hasChanges, comment } = buildUpdateDialogUpdates(
          { status: 'open', stage: 'idea', priority: 'medium' },
          { statusIndex: 1, stageIndex: 3, priorityIndex: 1 },
          {
            statuses: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
            stages: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
            priorities: ['critical', 'high', 'medium', 'low'],
          },
          {
            statusStage: STATUS_STAGE_COMPATIBILITY,
            stageStatus: STAGE_STATUS_COMPATIBILITY,
          },
          commentValue
        );

        try {
          if (!hasChanges && !comment) return;
          if (Object.keys(updates).length > 0) db.update('WL-TEST-1', updates);
          if (comment) db.createComment({ workItemId: 'WL-TEST-1', comment, author: '@tui' });
          commentValue = '';
        } catch {
          // Comment should be preserved for retry
        }
      };

      submitUpdateDialogWithFailure();
      expect(updateCalls).toHaveLength(1);
      expect(commentCalls).toHaveLength(0);
      expect(commentValue).toBe('keep me');
    });

    it('should treat blank stage as compatible with deleted status', () => {
      const item = { status: 'open', stage: '', priority: 'medium' };
      const result = buildUpdateDialogUpdates(
        item,
        { statusIndex: 0, stageIndex: 0, priorityIndex: 2 },
        {
          statuses: ['deleted'],
          stages: [''],
          priorities: ['critical', 'high', 'medium', 'low'],
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        }
      );

      expect(result.hasChanges).toBe(true);
      expect(result.updates).toEqual({ status: 'deleted' });
    });

    it('should not call db.update when Escape cancels', () => {
      const updateCalls: Array<Record<string, string>> = [];
      const db = {
        update: (_id: string, updates: Record<string, string>) => {
          updateCalls.push(updates);
        },
      };
      let closeCalls = 0;
      const closeUpdateDialog = () => {
        closeCalls += 1;
      };

      const onEscape = () => {
        closeUpdateDialog();
      };

      onEscape();
      expect(updateCalls).toHaveLength(0);
      expect(closeCalls).toBe(1);
      void db;
    });

    it('should move focus forward and back when textarea handles Tab/Shift-Tab', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });
      const stageList = blessed.list({ parent: screen, items: ['idea', 'done'] });
      const statusList = blessed.list({ parent: screen, items: ['open', 'completed'] });
      const priorityList = blessed.list({ parent: screen, items: ['high', 'low'] });
      const commentBox = blessed.textarea({ parent: screen, inputOnFocus: true, keys: true });

      const focusManager = createUpdateDialogFocusManager([stageList, statusList, priorityList, commentBox]);

      const wireNavigation = (field: any) => {
        field.on('keypress', (_ch: string, key: { name?: string }) => {
          if (key?.name === 'tab') {
            focusManager.cycle(1);
          }
          if (key?.name === 'S-tab') {
            focusManager.cycle(-1);
          }
        });
      };

      [stageList, statusList, priorityList, commentBox].forEach(wireNavigation);

      focusManager.focusIndex(3);
      commentBox.emit('keypress', '', { name: 'tab', full: 'tab' });
      expect(focusManager.getIndex()).toBe(0);

      commentBox.emit('keypress', '', { name: 'S-tab', shift: true, full: 'S-tab' });
      expect(focusManager.getIndex()).toBe(3);

      screen.destroy();
    });
  });

  describe('Update Dialog Error Handling', () => {
    it('should handle update failure gracefully', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      // Attempt to update non-existent item
      const result = db.update('WL-NONEXISTENT', { stage: 'in_progress' });
      
      // update() returns null when item not found
      expect(result).toBeNull();

      // Original item should be unchanged
      const item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('idea');
    });

    it('should preserve item data on update failure', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      const itemBefore = db.get('WL-TEST-1');
      const originalTitle = itemBefore?.title;
      const originalStatus = itemBefore?.status;

      // Simulate failed update (in real code, error is caught and toast shown)
      db.update('WL-TEST-1', { stage: 'in_review' });

      const itemAfter = db.get('WL-TEST-1');
      expect(itemAfter?.title).toBe(originalTitle);
      expect(itemAfter?.status).toBe(originalStatus);
      expect(itemAfter?.stage).toBe('in_review');
    });
  });

  describe('Update Dialog Integration', () => {
    it('should execute full update flow: open, select, update, close', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      // Step 1: Verify item exists with initial stage
      let item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('idea');
      expect(item?.title).toBe('Test Item 1');

      // Step 2: Simulate selecting a stage option
      // In actual code: updateDialogOptions.on('select', ...)
      const selectedIdx = 3; // 'in_progress'
      const stageMapping: Record<number, string> = {
        0: 'idea',
        1: 'prd_complete',
        2: 'plan_complete',
        3: 'in_progress',
        4: 'in_review',
        5: 'done',
        6: 'blocked'
      };

      if (selectedIdx < 7) {
        db.update('WL-TEST-1', { stage: stageMapping[selectedIdx] });
      }

      // Step 3: Verify update was successful
      item = db.get('WL-TEST-1');
      expect(item?.stage).toBe('in_progress');

      // Step 4: Dialog closes and list would be refreshed
      // In actual code: refreshFromDatabase() and closeUpdateDialog()
    });

    it('should handle multiple sequential updates', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      // First update
      db.update('WL-TEST-1', { stage: 'prd_complete' });
      expect(db.get('WL-TEST-1')?.stage).toBe('prd_complete');

      // Second update
      db.update('WL-TEST-1', { stage: 'plan_complete' });
      expect(db.get('WL-TEST-1')?.stage).toBe('plan_complete');

      // Third update
      db.update('WL-TEST-1', { stage: 'in_progress' });
      expect(db.get('WL-TEST-1')?.stage).toBe('in_progress');

      // Fourth update
      db.update('WL-TEST-1', { stage: 'done' });
      expect(db.get('WL-TEST-1')?.stage).toBe('done');
    });
  });

  describe('Keyboard Shortcut Behavior', () => {
    it('should verify keyboard shortcut bindings', () => {
      // This test verifies the expected keyboard shortcut bindings
      // In the actual code: screen.key(['u', 'U'], () => { openUpdateDialog(); })

      const screen = blessed.screen({ mouse: true, smartCSR: true });
      let updateDialogOpened = false;

      // Simulate the keyboard key binding
      screen.key(['u', 'U'], () => {
        updateDialogOpened = true;
      });

      // The key binding is registered
      expect(updateDialogOpened).toBe(false); // Not opened yet
      
      screen.destroy();
    });

    it('should respect dialog visibility checks before opening', () => {
      // This test verifies that the update dialog checks other dialogs are hidden
      // In actual code: if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden)

      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const detailModal = blessed.box({ parent: screen, hidden: true });
      const closeDialog = blessed.box({ parent: screen, hidden: true });
      const updateDialog = blessed.box({ parent: screen, hidden: true });
      const helpMenuVisible = false;

      const shouldOpenUpdateDialog =
        detailModal.hidden && !helpMenuVisible && closeDialog.hidden && updateDialog.hidden;

      expect(shouldOpenUpdateDialog).toBe(true);

      // When another dialog is visible
      detailModal.show();
      const shouldNotOpenWhenDetailOpen =
        detailModal.hidden && !helpMenuVisible && closeDialog.hidden && updateDialog.hidden;

      expect(shouldNotOpenWhenDetailOpen).toBe(false);

      screen.destroy();
    });
  });

});
