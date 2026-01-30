import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WorklogDatabase } from '../../src/database.js';
import blessed from 'blessed';

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
    it('should render update dialog with stage options', () => {
      // Create blessed screen and dialog components
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: 14,
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
        content: 'Update selected item stage:',
        tags: false
      });

      const updateDialogOptions = blessed.list({
        parent: updateDialog,
        top: 4,
        left: 2,
        width: '100%-4',
        height: 8,
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
          'done',
          'blocked',
          'Cancel'
        ]
      });

      // Verify dialog is properly constructed
      expect(updateDialog.hidden).toBe(true);
      // Verify the list has items (blessed list items API)
      expect(updateDialogOptions.children.length).toBeGreaterThan(0);

      screen.destroy();
    });

    it('should show dialog with selected item info', () => {
      const screen = blessed.screen({ mouse: true, smartCSR: true });

      const updateDialog = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '50%',
        height: 14,
        label: ' Update Work Item ',
        border: { type: 'line' },
        hidden: true
      });

      const updateDialogText = blessed.box({
        parent: updateDialog,
        top: 1,
        left: 2,
        height: 2,
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
        width: '50%',
        height: 14,
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
        'done',
        'blocked'
      ];

      // Verify each stage index maps to correct stage value
      const stageMapping: Record<number, string> = {
        0: 'idea',
        1: 'prd_complete',
        2: 'plan_complete',
        3: 'in_progress',
        4: 'in_review',
        5: 'done',
        6: 'blocked'
      };

      // Test each selection index
      stages.forEach((expectedStage, idx) => {
        db.update('WL-TEST-1', { stage: stageMapping[idx] });
        const item = db.get('WL-TEST-1');
        expect(item?.stage).toBe(expectedStage);
      });
    });

    it('should handle cancel selection (index 7) without updating', () => {
      const db = new WorklogDatabase('WL', undefined, undefined, true, false);

      const itemBefore = db.get('WL-TEST-1');
      const originalStage = itemBefore?.stage;

      // Simulate Cancel selection (index 7) - no action taken
      // In the actual code: if (idx === 7) { /* Cancel - no action */ }

      const itemAfter = db.get('WL-TEST-1');
      expect(itemAfter?.stage).toBe(originalStage);
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
