/**
 * TUI command - interactive tree view for work items
 */

import type { PluginContext } from '../plugin-types.js';
import blessed from 'blessed';
import { humanFormatWorkItem, sortByPriorityAndDate, formatTitleOnly } from './helpers.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';
import { resolveWorklogDir } from '../worklog-paths.js';
import { spawn, spawnSync } from 'child_process';
import { OpencodeClient, type OpencodeServerStatus } from '../tui/opencode-client.js';
import {
  DetailComponent,
  DialogsComponent,
  HelpMenuComponent,
  ListComponent,
  ModalDialogsComponent,
  OpencodePaneComponent,
  OverlaysComponent,
  ToastComponent,
} from '../tui/components/index.js';

type Item = any;

export default function register(ctx: PluginContext): void {
  const { program, utils } = ctx;
  // Allow tests to inject a mocked blessed implementation via the ctx object.
  // If not provided, fall back to the real blessed import.
  const blessedImpl = (ctx as any).blessed || blessed;

  program
    .command('tui')
    .description('Interactive TUI: browse work items in a tree (use --in-progress to show only in-progress)')
    .option('--in-progress', 'Show only in-progress items')
    .option('--all', 'Include completed/deleted items in the list')
    .option('--prefix <prefix>', 'Override the default prefix')
    .action((options: { inProgress?: boolean; prefix?: string; all?: boolean }) => {
      utils.requireInitialized();
      const db = utils.getDatabase(options.prefix);
      const isVerbose = !!program.opts().verbose;
      const debugLog = (message: string) => {
        if (!isVerbose) return;
        console.error(`[tui:opencode] ${message}`);
      };

      const query: any = {};
      if (options.inProgress) query.status = 'in-progress';

      let items: Item[] = db.list(query);
      // By default hide closed items (completed or deleted) unless --all is set
      const visibleItems = options.all ? items : items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
      if (visibleItems.length === 0) {
        console.log('No work items found');
        return;
      }

      let showClosed = Boolean(options.all);
      let currentVisibleItems: Item[] = visibleItems.slice();
      let itemsById = new Map<string, Item>();
      let childrenMap = new Map<string, Item[]>();
      let roots: Item[] = [];

      function rebuildTree() {
        currentVisibleItems = showClosed
          ? items.slice()
          : items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');

        itemsById = new Map<string, Item>();
        for (const it of currentVisibleItems) itemsById.set(it.id, it);

        childrenMap = new Map<string, Item[]>();
        for (const it of currentVisibleItems) {
          const pid = it.parentId;
          if (pid && itemsById.has(pid)) {
            const arr = childrenMap.get(pid) || [];
            arr.push(it);
            childrenMap.set(pid, arr);
          }
        }

        roots = currentVisibleItems.filter(it => !it.parentId || !itemsById.has(it.parentId)).slice();
        roots.sort(sortByPriorityAndDate);

        // prune expanded nodes that are no longer present
        for (const id of Array.from(expanded)) {
          if (!itemsById.has(id)) expanded.delete(id);
        }
      }

      // Track expanded state by id
      const expanded = new Set<string>();

      // Persisted state file per-worklog directory
      const worklogDir = resolveWorklogDir();
      const statePath = path.join(worklogDir, 'tui-state.json');

      // Load persisted state for this prefix if present
      function loadPersistedState(prefix: string | undefined) {
        try {
          if (!fs.existsSync(statePath)) return null;
          const raw = fs.readFileSync(statePath, 'utf8');
          const j = JSON.parse(raw || '{}');
          const val = j[prefix || 'default'] || null;
          debugLog(`loadPersistedState prefix=${String(prefix || 'default')} path=${statePath} present=${val !== null}`);
          return val;
        } catch (err) {
          debugLog(`loadPersistedState error: ${String(err)}`);
          return null;
        }
      }

      function savePersistedState(prefix: string | undefined, state: any) {
        try {
          if (!fs.existsSync(worklogDir)) fs.mkdirSync(worklogDir, { recursive: true });
          let j: any = {};
          if (fs.existsSync(statePath)) {
            try { j = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}'); } catch { j = {}; }
          }
          j[prefix || 'default'] = state;
          fs.writeFileSync(statePath, JSON.stringify(j, null, 2), 'utf8');
          try {
            const keys = Object.keys(state || {}).join(',');
            debugLog(`savePersistedState prefix=${String(prefix || 'default')} path=${statePath} keys=[${keys}]`);
          } catch (_) {}
        } catch (err) {
          debugLog(`savePersistedState error: ${String(err)}`);
          // ignore persistence errors but log for debugging
        }
      }

      // Default expand roots unless persisted state exists
      const persisted = loadPersistedState(db.getPrefix?.() || undefined);
      if (persisted && Array.isArray(persisted.expanded)) {
        for (const id of persisted.expanded) expanded.add(id);
      } else {
        // temp expand roots; actual roots set after rebuildTree
      }

      rebuildTree();
      if (!persisted || !Array.isArray(persisted.expanded)) {
        for (const r of roots) expanded.add(r.id);
      }

      // Flatten visible nodes for rendering
      type VisibleNode = { item: Item; depth: number; hasChildren: boolean };

      function buildVisible(): VisibleNode[] {
        const out: VisibleNode[] = [];

        function visit(it: Item, depth: number) {
          const children = (childrenMap.get(it.id) || []).slice().sort(sortByPriorityAndDate);
          out.push({ item: it, depth, hasChildren: children.length > 0 });
          if (children.length > 0 && expanded.has(it.id)) {
            for (const c of children) visit(c, depth + 1);
          }
        }

        for (const r of roots) visit(r, 0);
        return out;
      }

      // Setup blessed screen and layout
      const screen = blessedImpl.screen({ smartCSR: true, title: 'Worklog TUI', mouse: true });

      const listComponent = new ListComponent({ parent: screen, blessed: blessedImpl }).create();
      const list = listComponent.getList();
      const help = listComponent.getFooter();

      const detailComponent = new DetailComponent({ parent: screen, blessed: blessedImpl }).create();
      const detail = detailComponent.getDetail();
      const copyIdButton = detailComponent.getCopyIdButton();

      const toastComponent = new ToastComponent({
        parent: screen,
        blessed: blessedImpl,
        position: { bottom: 1, right: 1 },
        style: { fg: 'black', bg: 'green' },
        duration: 1200,
      }).create();

      const overlaysComponent = new OverlaysComponent({ parent: screen, blessed: blessedImpl }).create();
      const dialogsComponent = new DialogsComponent({ parent: screen, blessed: blessedImpl, overlays: overlaysComponent }).create();

      const detailOverlay = overlaysComponent.detailOverlay;
      const detailModal = dialogsComponent.detailModal;
      const detailClose = dialogsComponent.detailClose;

      const closeOverlay = overlaysComponent.closeOverlay;
      const closeDialog = dialogsComponent.closeDialog;
      const closeDialogText = dialogsComponent.closeDialogText;
      const closeDialogOptions = dialogsComponent.closeDialogOptions;

      const updateOverlay = overlaysComponent.updateOverlay;
      const updateDialog = dialogsComponent.updateDialog;
      const updateDialogText = dialogsComponent.updateDialogText;
      const updateDialogOptions = dialogsComponent.updateDialogOptions;

      const nextOverlay = blessedImpl.box({
        parent: screen,
        top: 0,
        left: 0,
        width: '100%',
        height: '100% - 1',
        hidden: true,
        mouse: true,
        clickable: true,
        style: { bg: 'black' },
      });

      const nextDialog = blessedImpl.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '60%',
        height: 12,
        label: ' Next Work Item ',
        border: { type: 'line' },
        hidden: true,
        tags: true,
        mouse: true,
        clickable: true,
        style: { border: { fg: 'cyan' } },
      });

      const nextDialogClose = blessedImpl.box({
        parent: nextDialog,
        top: 0,
        right: 1,
        height: 1,
        width: 3,
        content: '[x]',
        style: { fg: 'red' },
        mouse: true,
        clickable: true,
      });

      const nextDialogText = blessedImpl.box({
        parent: nextDialog,
        top: 1,
        left: 2,
        width: '100%-4',
        height: 5,
        content: 'Evaluating next work item...',
        tags: true,
      });

      const nextDialogOptions = blessedImpl.list({
        parent: nextDialog,
        top: 7,
        left: 2,
        width: '100%-4',
        height: 3,
        keys: true,
        mouse: true,
        style: {
          selected: { bg: 'blue' },
        },
        items: ['View', 'Close'],
      });

      const helpMenu = new HelpMenuComponent({ parent: screen, blessed: blessedImpl }).create();

      const modalDialogs = new ModalDialogsComponent({ parent: screen, blessed: blessedImpl }).create();

      const opencodeUi = new OpencodePaneComponent({ parent: screen, blessed: blessedImpl }).create();
      const serverStatusBox = opencodeUi.serverStatusBox;
      const opencodeDialog = opencodeUi.dialog;
      const opencodeText = opencodeUi.textarea;
      const suggestionHint = opencodeUi.suggestionHint;
      const opencodeSend = opencodeUi.sendButton;
      const opencodeCancel = opencodeUi.cancelButton;

      const setBorderFocusStyle = (element: any, focused: boolean) => {
        if (!element?.style) return;
        const border = element.style.border || (element.style.border = {});
        border.fg = focused ? 'green' : 'white';
        const labelStyle = element.style.label || (element.style.label = {});
        labelStyle.fg = focused ? 'green' : 'white';
      };

      const setDetailBorderFocusStyle = (focused: boolean) => {
        setBorderFocusStyle(detail, focused);
      };

      const setListBorderFocusStyle = (focused: boolean) => {
        setBorderFocusStyle(list, focused);
      };

      const setOpencodeBorderFocusStyle = (focused: boolean) => {
        setBorderFocusStyle(opencodeDialog, focused);
      };

      const paneForNode = (node: any): any => {
        if (!node) return null;
        if (node === list) return list;
        if (node === detail) return detail;
        if (node === opencodeDialog || node === opencodeText) return opencodeDialog;
        if (node === opencodePane) return opencodeDialog;
        return null;
      };
      let paneFocusIndex = 0;
      let lastPaneFocusIndex = 0;

      const getFocusPanes = (): any[] => {
        const panes = [list, detail];
        if (!opencodeDialog.hidden) panes.push(opencodeDialog);
        return panes;
      };

      const getActivePaneIndex = (): number => {
        const panes = getFocusPanes();
        const focus = paneForNode(screen.focused);
        if (!focus) return paneFocusIndex;
        const idx = panes.indexOf(focus);
        return idx >= 0 ? idx : paneFocusIndex;
      };

      const syncFocusFromScreen = () => {
        const panes = getFocusPanes();
        const focus = paneForNode(screen.focused);
        if (!focus) return;
        const idx = panes.indexOf(focus);
        if (idx >= 0) {
          lastPaneFocusIndex = paneFocusIndex;
          paneFocusIndex = idx;
          applyFocusStyles();
        }
      };

      const focusPaneByIndex = (idx: number) => {
        const panes = getFocusPanes();
        if (panes.length === 0) return;
        const clamped = ((idx % panes.length) + panes.length) % panes.length;
        lastPaneFocusIndex = paneFocusIndex;
        paneFocusIndex = clamped;
        const target = panes[clamped];
        if (target === opencodeDialog) {
          opencodeText.focus();
        } else {
          target.focus();
        }
        applyFocusStyles();
      };

      const cycleFocus = (direction: 1 | -1) => {
        const current = getActivePaneIndex();
        focusPaneByIndex(current + direction);
      };

      const applyFocusStyles = () => {
        const active = getFocusPanes()[paneFocusIndex];
        setListBorderFocusStyle(active === list);
        setDetailBorderFocusStyle(active === detail);
        setOpencodeBorderFocusStyle(active === opencodeDialog);
      };

      const applyFocusStylesForPane = (pane: any) => {
        setListBorderFocusStyle(pane === list);
        setDetailBorderFocusStyle(pane === detail);
        setOpencodeBorderFocusStyle(pane === opencodeDialog);
      };

       let ctrlWPending = false;
       let ctrlWTimeout: ReturnType<typeof setTimeout> | null = null;
       let lastCtrlWTime = 0;
       let suppressNextP = false;  // Flag to suppress 'p' handler after Ctrl-W p
       let lastCtrlWKeyHandled = false;  // Flag to suppress widget key handling after Ctrl-W command
       
       const setCtrlWPending = () => {
         console.error(`[TUI] Setting ctrlWPending = true (timestamp: ${Date.now()})`);
         ctrlWPending = true;
         lastCtrlWTime = Date.now();
         if (ctrlWTimeout) clearTimeout(ctrlWTimeout);
         ctrlWTimeout = setTimeout(() => {
           console.error(`[TUI] Clearing ctrlWPending (timeout)`);
           ctrlWPending = false;
           ctrlWTimeout = null;
         }, 2000);  // Increased to 2 seconds
       };

       const handleCtrlWCommand = (name?: string) => {
         console.error(`[TUI] handleCtrlWCommand(name="${name}")`);
         if (!name) return false;
         if (helpMenu.isVisible()) return false;
         if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return false;
         if (name === 'w') {
           console.error(`[TUI] Handling Ctrl-W w (cycleFocus)`);
           cycleFocus(1);
           screen.render();
           return true;
         }
         if (name === 'p') {
           console.error(`[TUI] Handling Ctrl-W p (previous pane)`);
           focusPaneByIndex(lastPaneFocusIndex);
           screen.render();
           return true;
         }
          if (name === 'h') {
            console.error(`[TUI] Handling Ctrl-W h (focus left with wrap)`);
            const current = getActivePaneIndex();
            focusPaneByIndex(current - 1);  // Cycle backward (wraps around)
            screen.render();
            return true;
          }
          if (name === 'l') {
            console.error(`[TUI] Handling Ctrl-W l (focus right with wrap)`);
            const current = getActivePaneIndex();
            focusPaneByIndex(current + 1);  // Cycle forward (wraps around)
            screen.render();
            return true;
          }
          if (name === 'k') {
            console.error(`[TUI] Handling Ctrl-W k (focus up/opencodePane)`);
            if (opencodeDialog.hidden) return false;
            if (!opencodePane || opencodePane.hidden) return false;
            opencodePane.focus();
            syncFocusFromScreen();
            screen.render();
            return true;
          }
          if (name === 'j') {
            console.error(`[TUI] Handling Ctrl-W j (focus down/opencodeText)`);
            if (opencodeDialog.hidden) return false;
            if (!opencodePane || opencodePane.hidden) return false;
            opencodeText.focus();
            syncFocusFromScreen();
            screen.render();
            return true;
          }
         console.error(`[TUI] handleCtrlWCommand: unrecognized key "${name}"`);
         return false;
       };

       const handleCtrlWPendingKey = (name?: string) => {
         console.error(`[TUI] handleCtrlWPendingKey(name="${name}", ctrlWPending=${ctrlWPending})`);
         if (!ctrlWPending) {
           console.error(`[TUI] ctrlWPending is false, ignoring key`);
           return false;
         }
         ctrlWPending = false;
         return handleCtrlWCommand(name);
       };

       const attachCtrlWPendingHandler = (widget: any) => {
         widget.on('keypress', (_ch: any, key: any) => {
           console.error(`[TUI] Widget keypress handler fired: key.name="${key?.name}", key.ctrl=${key?.ctrl}`);
           if (handleCtrlWPendingKey(key?.name)) {
             console.error(`[TUI] Widget handler: handleCtrlWPendingKey returned true, consuming event`);
             return false;
           }
         });
       };



      // Command autocomplete support
      const AVAILABLE_COMMANDS = [
        '/help',
        '/clear',
        '/save',
        '/export',
        '/import',
        '/test',
        '/build',
        '/run',
        '/debug',
        '/search',
        '/replace',
        '/refactor',
        '/explain',
        '/review',
        '/commit',
        '/push',
        '/pull',
        '/status',
        '/diff',
        '/log',
        '/branch',
        '/merge',
        '/rebase',
        '/checkout',
        '/stash',
        '/tag',
        '/reset',
        '/revert'
      ];

      // Autocomplete state
      let currentSuggestion = '';
      let isCommandMode = false;
      let userTypedText = '';
      let isWaitingForResponse = false; // Track if we're waiting for OpenCode response

      function applyCommandSuggestion(target: any) {
        if (isCommandMode && currentSuggestion) {
          target.setValue(currentSuggestion + ' ');
          if (target.moveCursor) {
            target.moveCursor(currentSuggestion.length + 1);
          }
          currentSuggestion = '';
          isCommandMode = false;
          suggestionHint.setContent('');
          screen.render();
          return true;
        }
        return false;
      }

      function updateAutocomplete() {
        const value = opencodeText.getValue ? opencodeText.getValue() : '';
        userTypedText = value;
        const lines = value.split('\n');
        const firstLine = lines[0];
        const commandLine = firstLine;
        
        // Check if we're in command mode (first line starts with '/')
        if (commandLine.startsWith('/') && lines.length === 1) {
          isCommandMode = true;
          const input = commandLine.toLowerCase();
          
          // Find the best matching command
          const matches = AVAILABLE_COMMANDS.filter(cmd => 
            cmd.toLowerCase().startsWith(input)
          );
          
          if (matches.length > 0 && matches[0] !== input) {
            currentSuggestion = matches[0];
            // Show suggestion as hint text below the input
            suggestionHint.setContent(`{gray-fg}↳ ${currentSuggestion}{/gray-fg}`);
          } else {
            currentSuggestion = '';
            suggestionHint.setContent('');
          }
        } else {
          isCommandMode = false;
          currentSuggestion = '';
          suggestionHint.setContent('');
        }
        screen.render();
      }

       // Hook into textarea input to update autocomplete
       opencodeText.on('keypress', function(this: any, _ch: any, _key: any) {
         console.error(`[TUI] opencodeText keypress: _ch="${_ch}", key.name="${_key?.name}", key.ctrl=${_key?.ctrl}, lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
         
         // Suppress j/k when they were just handled as Ctrl-W commands
         if (lastCtrlWKeyHandled && ['j', 'k'].includes(_key?.name)) {
           console.error(`[TUI] opencodeText: Suppressing '${_key?.name}' key (Ctrl-W command) - returning false`);
           return false;  // Consume the event
         }
         
         // ALSO check if we're in the middle of a Ctrl-W sequence
         if (ctrlWPending && ['j', 'k'].includes(_key?.name)) {
           console.error(`[TUI] opencodeText: ctrlWPending is true and key is j/k - consuming event to prevent typing`);
           return false;
         }
         
         // Handle Ctrl+Enter for newline insertion  
         if (_key && _key.name === 'linefeed') {
          // Get CURRENT value BEFORE the textarea adds the newline
          const currentValue = this.getValue ? this.getValue() : '';
          const currentLines = currentValue.split('\n').length;
          
          // Calculate what the height WILL BE after the newline
          const futureLines = currentLines + 1;
          const desiredHeight = Math.min(Math.max(MIN_INPUT_HEIGHT, futureLines + 2), inputMaxHeight());
          
          // Resize the dialog FIRST
          opencodeDialog.height = desiredHeight;
          opencodeText.height = desiredHeight - 2;
          
          if (opencodePane) {
            opencodePane.bottom = desiredHeight + FOOTER_HEIGHT;
            opencodePane.height = paneHeight();
          }
          
          // Render with new size
          screen.render();
          
          // After the event loop completes and blessed inserts the newline, scroll to bottom
          setImmediate(() => {
            // Scroll to bottom to keep cursor visible
            if (this.setScrollPerc) {
              this.setScrollPerc(100);
            }
            
            screen.render();
          });
          
          // Don't call updateOpencodeInputLayout as we've handled the resize
          return;
        }
        
        // Update immediately on keypress for better responsiveness
        process.nextTick(() => {
          updateAutocomplete();
          updateOpencodeInputLayout();
        });
      });



      // Active opencode pane/process tracking
      let opencodePane: any = null;

      const MIN_INPUT_HEIGHT = 3;  // Minimum height for input dialog (single line + borders)
      const MAX_INPUT_LINES = 7;   // Maximum visible lines of input text
      const FOOTER_HEIGHT = 1;
      const availableHeight = () => Math.max(10, (screen.height as number) - FOOTER_HEIGHT);
      const inputMaxHeight = () => Math.min(MAX_INPUT_LINES + 2, Math.floor(availableHeight() * 0.3)); // +2 for borders
      const paneHeight = () => Math.max(6, Math.floor(availableHeight() * 0.5));

      function updateOpencodeInputLayout() {
        if (!opencodeText.getValue) return;
        const value = opencodeText.getValue();
        const lines = value.split('\n').length;
        // Dialog height = content lines + 2 for borders
        const desiredHeight = Math.min(Math.max(MIN_INPUT_HEIGHT, lines + 2), inputMaxHeight());
        opencodeDialog.height = desiredHeight;
        
        // Always use compact mode settings
        (opencodeText as any).border = false;
        opencodeText.top = 0;  // Position at top of dialog interior
        opencodeText.left = 0;  // Position at left of dialog interior
        opencodeText.width = '100%-2';  // Leave 1 char padding on each side
        opencodeText.height = desiredHeight - 2;  // Height minus top and bottom borders
        // Ensure a style object exists but avoid replacing it entirely — blessed
        // keeps internal references to the original style object which must be
        // preserved. Create a style object only when missing (e.g. in tests).
        if (!opencodeText.style) {
          (opencodeText as any).style = {};
        }
        // Clear border and focus styles without replacing the entire style object
        if (opencodeText.style.border) {
          Object.keys(opencodeText.style.border).forEach(key => {
            delete opencodeText.style.border[key];
          });
        }
        if (opencodeText.style.focus) {
          if (opencodeText.style.focus.border) {
            Object.keys(opencodeText.style.focus.border).forEach(key => {
              delete opencodeText.style.focus.border[key];
            });
          }
        }
        
        if (opencodePane) {
          opencodePane.bottom = desiredHeight + FOOTER_HEIGHT;
          opencodePane.height = paneHeight();
          // No longer need to update close button position since it's in the label
        }
        screen.render();
      }

      async function openOpencodeDialog() {
        // Always use compact mode at bottom
        opencodeDialog.setLabel(' prompt [esc] ');
        opencodeDialog.top = undefined;  // Clear the center positioning
        opencodeDialog.left = 0;  // Clear the center positioning
        opencodeDialog.bottom = FOOTER_HEIGHT;
        opencodeDialog.width = '100%';
        opencodeDialog.height = MIN_INPUT_HEIGHT;
        
        // Adjust button positioning for compact mode
        suggestionHint.hide();
        opencodeSend.hide();  // Hide the send button
        opencodeCancel.hide();  // Hide the old cancel button since it's in the label now
        // Remove textarea border since dialog has the border
        (opencodeText as any).border = false;
        opencodeText.top = 0;  // Position at top of dialog interior
        opencodeText.left = 0;  // Position at left of dialog interior  
        opencodeText.width = '100%-2';  // Leave 1 char padding on each side
        opencodeText.height = MIN_INPUT_HEIGHT - 2;  // Height minus borders
        // Ensure a style object exists but avoid replacing it entirely — blessed
        // keeps internal references to the original style object which must be
        // preserved. Create a style object only when missing (e.g. in tests).
        if (!opencodeText.style) {
          (opencodeText as any).style = {};
        }
        // Clear border and focus styles without replacing the entire style object
        if (opencodeText.style.border) {
          Object.keys(opencodeText.style.border).forEach(key => {
            delete opencodeText.style.border[key];
          });
        }
        if (opencodeText.style.focus) {
          if (opencodeText.style.focus.border) {
            Object.keys(opencodeText.style.focus.border).forEach(key => {
              delete opencodeText.style.focus.border[key];
            });
          }
        }
        
        opencodeDialog.show();
        opencodeDialog.setFront();
        
        // Clear previous contents and focus textbox so typed characters appear
        try { if (typeof opencodeText.clearValue === 'function') opencodeText.clearValue(); } catch (_) {}
        try { if (typeof opencodeText.setValue === 'function') opencodeText.setValue(''); } catch (_) {}
        
        // Reset autocomplete state
        currentSuggestion = '';
        isCommandMode = false;
        userTypedText = '';
        suggestionHint.setContent('');
        opencodeText.focus();
        paneFocusIndex = getFocusPanes().indexOf(opencodeDialog);
        applyFocusStyles();
        // Don't move cursor since there's no prompt anymore
        updateOpencodeInputLayout();
        
        // Start the server if not already running
        await opencodeClient.startServer();
        
        // Open the response pane automatically
        ensureOpencodePane();
        
        screen.render();
      }

      function closeOpencodeDialog() {
        // In compact mode, don't hide the dialog - it stays as the input bar
        // Just clear the input and keep it open
        try { if (typeof opencodeText.clearValue === 'function') opencodeText.clearValue(); } catch (_) {}
        try { if (typeof opencodeText.setValue === 'function') opencodeText.setValue(''); } catch (_) {}
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function closeOpencodePane() {
        if (opencodePane) {
          opencodePane.hide();
        }
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      // OpenCode server management
      const OPENCODE_SERVER_PORT = parseInt(process.env.OPENCODE_SERVER_PORT || '9999', 10);

      function updateServerStatus(status: OpencodeServerStatus, port: number) {
        let statusText = '';
        let statusColor = 'white';

        switch (status) {
          case 'stopped':
            statusText = '[-] Server stopped';
            statusColor = 'gray';
            break;
          case 'starting':
            statusText = '[~] Starting...';
            statusColor = 'yellow';
            break;
          case 'running':
            statusText = `[OK] Port: ${port}`;
            statusColor = 'green';
            break;
          case 'error':
            statusText = '[X] Server error';
            statusColor = 'red';
            break;
        }
        const taggedContent = `{${statusColor}-fg}${statusText}{/}`;
        const plainLength = statusText.length;
        serverStatusBox.setContent(taggedContent);
        serverStatusBox.width = Math.max(1, plainLength + 2);
        screen.render();
      }

      const opencodeClient = new OpencodeClient({
        port: OPENCODE_SERVER_PORT,
        log: debugLog,
        showToast,
        modalDialogs,
        render: () => screen.render(),
        persistedState: {
          load: loadPersistedState,
          save: savePersistedState,
          getPrefix: () => db.getPrefix?.(),
        },
        onStatusChange: updateServerStatus,
      });

      const initialStatus = opencodeClient.getStatus();
      updateServerStatus(initialStatus.status, initialStatus.port);
      
      function ensureOpencodePane() {
        // In compact mode, adjust pane position to be above the input
        const currentHeight = opencodeDialog.height || MIN_INPUT_HEIGHT;
        const bottomOffset = currentHeight + FOOTER_HEIGHT;

        opencodePane = opencodeUi.ensureResponsePane({
          bottom: bottomOffset,
          height: paneHeight(),
          label: ' opencode [esc] ',
          onEscape: () => {
            closeOpencodePane();
            // Return focus to the input textbox if it's visible so the
            // user can continue typing.
            try {
              opencodeText.focus();
            } catch (_) {}
            // Prevent the global Escape handler from acting immediately
            // after we closed the pane.
            suppressEscapeUntil = Date.now() + 250;
          },
        });
      }

      async function runOpencode(prompt: string) {
        if (!prompt || prompt.trim() === '') {
          showToast('Empty prompt');
          return;
        }

        // Block if we're already waiting for a response
        if (isWaitingForResponse) {
          showToast('Please wait for current response to complete');
          return;
        }

        // Check server is running
        const serverStatus = opencodeClient.getStatus();
        if (serverStatus.status !== 'running' || serverStatus.port === 0) {
          showToast('OpenCode server not running');
          return;
        }

        ensureOpencodePane();
        opencodePane.show();
        opencodePane.setFront();
        screen.render();

        // Set flag to block new requests and update label
        isWaitingForResponse = true;
        opencodeDialog.setLabel(' prompt (waiting...) [esc] ');
        screen.render();

        // Use HTTP API to communicate with server
        try {
          await opencodeClient.sendPrompt({
            prompt,
            pane: opencodePane,
            indicator: null,
            inputField: opencodeText,
            getSelectedItemId: () => getSelectedItem()?.id ?? null,
            onComplete: () => {
            // Clear flag when response completes and restore label
            isWaitingForResponse = false;
            opencodeDialog.setLabel(' prompt [esc] ');
            openOpencodeDialog();
            },
          });
        } catch (err) {
          // Clear flag on error too and restore label
          isWaitingForResponse = false;
          opencodeDialog.setLabel(' prompt [esc] ');
          opencodePane.pushLine(`{red-fg}Server communication error: ${err}{/red-fg}`);
          screen.render();
        }
      }

      // Opencode dialog controls
      opencodeSend.on('click', () => {
        const prompt = opencodeText.getValue ? opencodeText.getValue() : '';
        closeOpencodeDialog();
        runOpencode(prompt);
      });

      // Add Escape key handler to close the opencode dialog
      opencodeText.key(['escape'], function(this: any) {
        opencodeDialog.hide();
        if (opencodePane) {
          opencodePane.hide();
        }
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      });

      // Accept Ctrl+S to send (keep for backward compatibility)
      opencodeText.key(['C-s'], function(this: any) {
        if (applyCommandSuggestion(this)) {
          return;
        }
        const prompt = this.getValue ? this.getValue() : '';
        closeOpencodeDialog();
        runOpencode(prompt);
      });

       // Accept Enter to send, Ctrl+Enter for newline
       opencodeText.key(['enter'], function(this: any) {
         if (applyCommandSuggestion(this)) {
           return;
         }
         const prompt = this.getValue ? this.getValue() : '';
         closeOpencodeDialog();
         runOpencode(prompt);
       });

       // Suppress j/k keys when they're part of Ctrl-W commands
       opencodeText.key(['j'], function(this: any) {
         console.error(`[TUI] opencodeText.key(['j']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
         if (lastCtrlWKeyHandled) {
           console.error(`[TUI] opencodeText.key: Suppressing 'j' key (Ctrl-W command) - returning false`);
           return false;
         }
       });

       opencodeText.key(['k'], function(this: any) {
         console.error(`[TUI] opencodeText.key(['k']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
         if (lastCtrlWKeyHandled) {
           console.error(`[TUI] opencodeText.key: Suppressing 'k' key (Ctrl-W command) - returning false`);
           return false;
         }
       });


      // Pressing Escape while the dialog (or any child) is focused should
      // close both the input dialog and the response pane so the user returns
      // to the main list. This mirrors the behaviour when Escape is pressed
      // inside the textarea itself.
      opencodeDialog.key(['escape'], () => {
        opencodeDialog.hide();
        if (opencodePane) {
          opencodePane.hide();
        }
        // Prevent the global Escape handler from acting on the same
        // keypress and exiting the TUI.
        suppressEscapeUntil = Date.now() + 250;
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      });


      let listLines: string[] = [];
      function renderListAndDetail(selectIndex = 0) {
        const visible = buildVisible();
        const lines = visible.map(n => {
          const indent = '  '.repeat(n.depth);
          const marker = n.hasChildren ? (expanded.has(n.item.id) ? '▾' : '▸') : ' ';
          const title = formatTitleOnly(n.item);
          return `${indent}${marker} ${title} {gray-fg}({underline}${n.item.id}{/underline}){/gray-fg}`;
        });
        listLines = lines;
        list.setItems(lines);
        // Keep selection in bounds
        const idx = Math.max(0, Math.min(selectIndex, lines.length - 1));
        list.select(idx);
        updateDetailForIndex(idx, visible);
        // Update footer/help with right-aligned closed toggle
        try {
          const closedCount = items.filter((item: any) => item.status === 'completed' || item.status === 'deleted').length;
          const leftText = 'Press ? for help';
          const rightText = `Closed (${closedCount}): ${showClosed ? 'Shown' : 'Hidden'}`;
          const cols = screen.width as number;
          if (cols && cols > leftText.length + rightText.length + 2) {
            const gap = cols - leftText.length - rightText.length;
            help.setContent(`${leftText}${' '.repeat(gap)}${rightText}`);
          } else {
            help.setContent(`${leftText} • ${rightText}`);
          }
        } catch (err) {
          // ignore
        }
        screen.render();
      }

      function escapeBlessedTags(value: string): string {
        const helper = (blessedImpl as any)?.helpers?.escape;
        if (typeof helper === 'function') {
          return helper(value);
        }
        return value.replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
      }

      function updateDetailForIndex(idx: number, visible?: VisibleNode[]) {
        const v = visible || buildVisible();
        if (v.length === 0) {
          detail.setContent('');
          return;
        }
        const node = v[idx] || v[0];
        const text = humanFormatWorkItem(node.item, db, 'full');
        const escaped = escapeBlessedTags(text);
        detail.setContent(decorateIdsForClick(escaped));
        detail.setScroll(0);
      }

      function stripAnsi(value: string): string {
        return value.replace(/\u001b\[[0-9;]*m/g, '');
      }

      function stripTags(value: string): string {
        return value.replace(/{[^}]+}/g, '');
      }

      function decorateIdsForClick(value: string): string {
        return value.replace(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/g, '{underline}$&{/underline}');
      }

      function extractIdFromLine(line: string): string | null {
        const plain = stripTags(stripAnsi(line));
        const match = plain.match(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/);
        return match ? match[0] : null;
      }

      function extractIdAtColumn(line: string, col?: number): string | null {
        const plain = stripTags(stripAnsi(line));
        const matches = Array.from(plain.matchAll(/\b[A-Z][A-Z0-9]+-[A-Z0-9-]+\b/g));
        if (matches.length === 0) return null;
        if (typeof col !== 'number') return matches[0][0];
        for (const match of matches) {
          const start = match.index ?? 0;
          const end = start + match[0].length;
          if (col >= start && col <= end) return match[0];
        }
        return null;
      }

      function getClickRow(box: any, data: any): { row: number; col: number } | null {
        const lpos = box?.lpos;
        const topBase = (lpos?.yi ?? box?.atop ?? 0) + (box?.itop ?? 0);
        const leftBase = (lpos?.xi ?? box?.aleft ?? 0) + (box?.ileft ?? 0);
        const row = (data?.y ?? 0) - topBase;
        const col = (data?.x ?? 0) - leftBase;
        if (row < 0 || col < 0) return null;
        return { row, col };
      }

      function getRenderedLineAtClick(box: any, data: any): string | null {
        const coords = getClickRow(box, data);
        if (!coords) return null;
        const scroll = typeof box.getScroll === 'function' ? (box.getScroll() as number) : 0;
        const lines = (box as any)?._clines?.real || (box as any)?._clines?.fake || box.getContent().split('\n');
        const lineIndex = coords.row + (scroll || 0);
        return lines[lineIndex] ?? null;
      }

      function getRenderedLineAtScreen(box: any, data: any): string | null {
        const lpos = box?.lpos;
        if (!lpos) return null;
        const scroll = typeof box.getScroll === 'function' ? (box.getScroll() as number) : 0;
        const lines = (box as any)?._clines?.real || (box as any)?._clines?.fake || box.getContent().split('\n');
        const base = (lpos.yi ?? 0);
        const offsets = [0, 1, 2, 3, -1, -2];
        for (const off of offsets) {
          const row = (data?.y ?? 0) - base - off;
          if (row < 0) continue;
          const lineIndex = row + (scroll || 0);
          if (lineIndex >= 0 && lineIndex < lines.length) return lines[lineIndex] ?? null;
        }
        return null;
      }

      let suppressDetailCloseUntil = 0;
      // Prevent the global Escape handler from immediately exiting when
      // a child control handles Escape (e.g. the input textarea).
      // Child handlers set this timestamp briefly to suppress the
      // global handler from acting on the same key event.
      let suppressEscapeUntil = 0;
      function openDetailsForId(id: string) {
        const item = db.get(id);
        if (!item) {
          showToast('Item not found');
          return;
        }
        detailOverlay.show();
        const text = humanFormatWorkItem(item, db, 'full');
        const escaped = escapeBlessedTags(text);
        detailModal.setContent(decorateIdsForClick(escaped));
        detailModal.setScroll(0);
        detailModal.show();
        detailOverlay.setFront();
        detailModal.setFront();
        detailModal.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        suppressDetailCloseUntil = Date.now() + 200;
        screen.render();
      }

      function openDetailsFromClick(line: string | null) {
        if (!line) return;
        const id = extractIdFromLine(line);
        if (!id) return;
        openDetailsForId(id);
      }

      function closeDetails() {
        detailModal.hide();
        detailOverlay.hide();
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function openCloseDialog() {
        const item = getSelectedItem();
        if (item) {
          closeDialogText.setContent(`Close: ${item.title}\nID: ${item.id}`);
        } else {
          closeDialogText.setContent('Close selected item with stage:');
        }
        closeOverlay.show();
        closeDialog.show();
        closeOverlay.setFront();
        closeDialog.setFront();
        closeDialogOptions.select(0);
        closeDialogOptions.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function closeCloseDialog() {
        closeDialog.hide();
        closeOverlay.hide();
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function openUpdateDialog() {
        const item = getSelectedItem();
        if (item) {
          updateDialogText.setContent(`Update: ${item.title}\nID: ${item.id}`);
        } else {
          updateDialogText.setContent('Update selected item stage:');
        }
        updateOverlay.show();
        updateDialog.show();
        updateOverlay.setFront();
        updateDialog.setFront();
        updateDialogOptions.select(0);
        updateDialogOptions.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function closeUpdateDialog() {
        updateDialog.hide();
        updateOverlay.hide();
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      function isInside(box: any, x: number, y: number): boolean {
        const lpos = box?.lpos;
        if (!lpos) return false;
        return x >= lpos.xi && x <= lpos.xl && y >= lpos.yi && y <= lpos.yl;
      }

      function openParentPreview() {
        const item = getSelectedItem();
        const parentId = item?.parentId;
        if (!parentId) {
          showToast('No parent');
          return;
        }
        openDetailsForId(parentId);
      }

      function refreshFromDatabase(preferredIndex?: number) {
        const selected = getSelectedItem();
        const selectedId = selected?.id;
        const query: any = {};
        if (options.inProgress) query.status = 'in-progress';
        items = db.list(query);
        const nextVisible = options.all
          ? items.slice()
          : items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
        if (nextVisible.length === 0) {
          list.setItems([]);
          detail.setContent('');
          screen.render();
          return;
        }
        rebuildTree();
        const visible = buildVisible();
        let nextIndex = 0;
        if (typeof preferredIndex === 'number') {
          nextIndex = Math.max(0, Math.min(preferredIndex, visible.length - 1));
        } else if (selectedId) {
          const found = visible.findIndex(n => n.item.id === selectedId);
          if (found >= 0) nextIndex = found;
        }
        renderListAndDetail(nextIndex);
      }

      function setFilterNext(filter: 'in-progress' | 'open' | 'blocked') {
        options.inProgress = false;
        options.all = false;
        showClosed = false;
        const selected = getSelectedItem();
        const selectedId = selected?.id;
        const query: any = {};
        if (filter === 'in-progress') query.status = 'in-progress';
        if (filter === 'blocked') query.status = 'blocked';
        items = db.list(query);
        const nextVisible = items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
        if (nextVisible.length === 0) {
          list.setItems([]);
          detail.setContent('');
          screen.render();
          return;
        }
        rebuildTree();
        const visible = buildVisible();
        let nextIndex = 0;
        if (selectedId) {
          const found = visible.findIndex(n => n.item.id === selectedId);
          if (found >= 0) nextIndex = found;
        }
        renderListAndDetail(nextIndex);
      }

      function getSelectedItem(): Item | null {
        const idx = list.selected as number;
        const visible = buildVisible();
        const node = visible[idx] || visible[0];
        return node?.item || null;
      }

      function copyToClipboard(text: string): { success: boolean; error?: string } {
        try {
          if (process.platform === 'darwin') {
            const result = spawnSync('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
            if (result.status === 0) return { success: true };
            return { success: false, error: result.error?.message || 'pbcopy failed' };
          }

          if (process.platform === 'win32') {
            const result = spawnSync('cmd', ['/c', 'clip'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
            if (result.status === 0) return { success: true };
            return { success: false, error: result.error?.message || 'clip failed' };
          }

          const xclip = spawnSync('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
          if (xclip.status === 0) return { success: true };

          const xsel = spawnSync('xsel', ['--clipboard', '--input'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
          if (xsel.status === 0) return { success: true };

          return { success: false, error: xclip.error?.message || xsel.error?.message || 'clipboard command not available' };
        } catch (err: any) {
          return { success: false, error: err?.message || 'clipboard copy failed' };
        }
      }

      function copySelectedId() {
        const item = getSelectedItem();
        if (!item) return;
        const result = copyToClipboard(item.id);
        if (result.success) showToast('ID copied');
        else showToast('Copy failed');
      }

      function closeSelectedItem(stage: 'in_review' | 'done' | 'deleted') {
        const item = getSelectedItem();
        if (!item) {
          showToast('No item selected');
          return;
        }
        const currentIndex = list.selected as number;
        const nextIndex = Math.max(0, currentIndex - 1);
        try {
          const updates = stage === 'deleted'
            ? { status: 'deleted' as const, stage: '' }
            : { status: 'completed' as const, stage };
          const updated = db.update(item.id, updates);
          if (!updated) {
            showToast('Close failed');
            return;
          }
          if (stage === 'deleted') showToast('Closed (deleted)');
          else showToast(stage === 'done' ? 'Closed (done)' : 'Closed (in_review)');
          refreshFromDatabase(nextIndex);
        } catch (err) {
          showToast('Close failed');
        }
      }

      function showToast(message: string) {
        toastComponent.show(message);
      }

      let nextWorkItem: Item | null = null;
      let nextWorkItemReason = '';
      let nextWorkItemRunning = false;

      function formatStageLabel(stage: string | undefined): string | null {
        if (stage === undefined) return null;
        if (stage === '') return 'Undefined';
        return stage;
      }

      function setNextDialogContent(content: string) {
        nextDialogText.setContent(content);
        screen.render();
      }

      function openNextDialog() {
        nextWorkItem = null;
        nextWorkItemReason = '';
        nextDialogOptions.select(0);
        nextOverlay.show();
        nextDialog.show();
        nextOverlay.setFront();
        nextDialog.setFront();
        nextDialogOptions.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        setNextDialogContent('Evaluating next work item...');
        runNextWorkItem();
      }

      function closeNextDialog() {
        nextDialog.hide();
        nextOverlay.hide();
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      }

      async function viewWorkItemInTree(id: string): Promise<boolean> {
        const visible = buildVisible();
        let found = visible.findIndex(node => node.item.id === id);
        if (found >= 0) {
          renderListAndDetail(found);
          list.focus();
          screen.render();
          return true;
        }

        if (itemsById.has(id)) {
          let cursor = itemsById.get(id) as Item | undefined;
          while (cursor?.parentId && itemsById.has(cursor.parentId)) {
            expanded.add(cursor.parentId);
            cursor = itemsById.get(cursor.parentId);
          }
          const expandedVisible = buildVisible();
          found = expandedVisible.findIndex(node => node.item.id === id);
          if (found >= 0) {
            renderListAndDetail(found);
            list.focus();
            screen.render();
            return true;
          }
        }

        closeNextDialog();
        const choice = await modalDialogs.selectList({
          title: 'Switch to ALL items?',
          message: 'The selected item is not visible. Switch to all items to locate it?',
          items: ['Switch to all items', 'Cancel'],
          defaultIndex: 0,
          cancelIndex: 1,
          height: 9,
        });

        if (choice !== 0) {
          list.focus();
          screen.render();
          return false;
        }

        showClosed = true;
        options.inProgress = false;
        options.all = true;
        items = db.list({}).filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
        rebuildTree();
        let refreshed = buildVisible();
        let refreshedIndex = refreshed.findIndex(node => node.item.id === id);
        if (refreshedIndex < 0 && itemsById.has(id)) {
          let cursor = itemsById.get(id) as Item | undefined;
          while (cursor?.parentId && itemsById.has(cursor.parentId)) {
            expanded.add(cursor.parentId);
            cursor = itemsById.get(cursor.parentId);
          }
          refreshed = buildVisible();
          refreshedIndex = refreshed.findIndex(node => node.item.id === id);
        }
        if (refreshedIndex >= 0) {
          renderListAndDetail(refreshedIndex);
          list.focus();
          screen.render();
          return true;
        }

        showToast('Item not found');
        return false;
      }

      function runNextWorkItem() {
        if (nextWorkItemRunning) return;
        nextWorkItemRunning = true;
        const args = ['next', '--json'];
        if (options.prefix) {
          args.push('--prefix', options.prefix);
        }
        const child = spawn('wl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', (err) => {
          nextWorkItemRunning = false;
          const message = `Error running wl next: ${String(err)}`;
          setNextDialogContent(`{red-fg}${message}{/red-fg}`);
        });

        child.on('close', (code) => {
          nextWorkItemRunning = false;
          if (code !== 0) {
            const errText = stderr.trim() || `wl next exited with code ${code}`;
            setNextDialogContent(`{red-fg}${errText}{/red-fg}`);
            return;
          }

          let payload: any = null;
          try {
            payload = JSON.parse(stdout.trim());
          } catch (err) {
            setNextDialogContent(`{red-fg}Failed to parse wl next output{/red-fg}`);
            return;
          }

          if (!payload?.success) {
            setNextDialogContent(`{red-fg}wl next did not return a result{/red-fg}`);
            return;
          }

          const workItem = payload.workItem;
          nextWorkItem = workItem || null;
          nextWorkItemReason = payload.reason || '';

          if (!workItem) {
            const reason = payload.reason ? `\nReason: ${payload.reason}` : '';
            setNextDialogContent(`No work item found.${reason}`);
            return;
          }

          const stageLabel = formatStageLabel(workItem.stage);
          const lines = [
            `{bold}${workItem.title}{/bold}`,
            `ID: ${workItem.id}`,
            `Status: ${workItem.status}${stageLabel ? ` · Stage: ${stageLabel}` : ''}`,
            `Priority: ${workItem.priority || 'none'}`,
          ];
          if (nextWorkItemReason) {
            lines.push(`Reason: ${nextWorkItemReason}`);
          }
          setNextDialogContent(lines.join('\n'));
        });
      }

      // Initial render
      renderListAndDetail(0);

      // Event handlers
      list.on('select', (_el: any, idx: number) => {
        const visible = buildVisible();
        updateDetailForIndex(idx, visible);
        screen.render();
      });

      list.on('select item', (_el: any, idx: number) => {
        const visible = buildVisible();
        updateDetailForIndex(idx, visible);
        screen.render();
      });

      // Update details immediately when navigating with keys or mouse
      list.on('keypress', (_ch: any, key: any) => {
        try {
          const nav = key && key.name && ['up', 'down', 'k', 'j', 'pageup', 'pagedown', 'home', 'end'].includes(key.name);
          if (nav) {
            const idx = list.selected as number;
            const visible = buildVisible();
            updateDetailForIndex(idx, visible);
            screen.render();
          }
        } catch (err) {
          // ignore render errors
        }
      });

       list.on('focus', () => {
         paneFocusIndex = getFocusPanes().indexOf(list);
         applyFocusStylesForPane(list);
       });

       detail.on('focus', () => {
         paneFocusIndex = getFocusPanes().indexOf(detail);
         applyFocusStylesForPane(detail);
       });

       opencodeDialog.on('focus', () => {
         paneFocusIndex = getFocusPanes().indexOf(opencodeDialog);
         applyFocusStylesForPane(opencodeDialog);
       });

       opencodeText.on('focus', () => {
         paneFocusIndex = getFocusPanes().indexOf(opencodeDialog);
         applyFocusStylesForPane(opencodeDialog);
       });

      list.on('click', () => {
        setTimeout(() => {
          const idx = list.selected as number;
          const visible = buildVisible();
          updateDetailForIndex(idx, visible);
          list.focus();
          paneFocusIndex = getFocusPanes().indexOf(list);
          applyFocusStylesForPane(list);
          screen.render();
        }, 0);
      });

      list.on('click', (data: any) => {
        const coords = getClickRow(list as any, data);
        if (!coords) return;
        const scroll = list.getScroll() as number;
        const lineIndex = coords.row + (scroll || 0);
        const line = listLines[lineIndex];
        if (!line) return;
        const id = extractIdAtColumn(line, coords.col);
        if (id) openDetailsForId(id);
      });

      detail.on('click', (data: any) => {
        detail.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtClick(detail as any, data));
      });

      detailModal.on('click', (data: any) => {
        detailModal.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtClick(detailModal as any, data));
      });

      detail.on('mouse', (data: any) => {
        if (data?.action === 'click') {
          detail.focus();
          paneFocusIndex = getFocusPanes().indexOf(detail);
          applyFocusStylesForPane(detail);
          openDetailsFromClick(getRenderedLineAtClick(detail as any, data));
        }
      });

      detail.on('mousedown', (data: any) => {
        detail.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
      });

      detail.on('mouseup', (data: any) => {
        detail.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
      });

      detailModal.on('mouse', (data: any) => {
        if (data?.action === 'click') {
          detailModal.focus();
          paneFocusIndex = getFocusPanes().indexOf(detail);
          applyFocusStylesForPane(detail);
          openDetailsFromClick(getRenderedLineAtClick(detailModal as any, data));
        }
      });

      detailClose.on('click', () => {
        closeDetails();
      });

      screen.key(['right', 'enter'], () => {
        const idx = list.selected as number;
        const visible = buildVisible();
        const node = visible[idx];
        if (node && node.hasChildren) {
          expanded.add(node.item.id);
          renderListAndDetail(idx);
        }
      });

      screen.key(['left'], () => {
        const idx = list.selected as number;
        const visible = buildVisible();
        const node = visible[idx];
        if (!node) return;
        if (node.hasChildren && expanded.has(node.item.id)) {
          expanded.delete(node.item.id);
          renderListAndDetail(idx);
          return;
        }
        // collapse parent if possible
        const parentIdx = findParentIndex(idx, visible);
        if (parentIdx >= 0) {
          const parent = visible[parentIdx];
          expanded.delete(parent.item.id);
          renderListAndDetail(parentIdx);
        }
      });

      function findParentIndex(idx: number, visible: VisibleNode[]): number {
        if (idx <= 0) return -1;
        const depth = visible[idx].depth;
        for (let i = idx - 1; i >= 0; i--) {
          if (visible[i].depth < depth) return i;
        }
        return -1;
      }

      // Toggle expand/collapse with space
      screen.key(['space'], () => {
        const idx = list.selected as number;
        const visible = buildVisible();
        const node = visible[idx];
        if (!node || !node.hasChildren) return;
        if (expanded.has(node.item.id)) expanded.delete(node.item.id);
        else expanded.add(node.item.id);
        renderListAndDetail(idx);
        // persist state
        savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(expanded) });
      });

      // Quit keys: q and Ctrl-C always quit; Escape should close the help overlay
      // when it's open instead of exiting the whole TUI.
      screen.key(['q', 'C-c'], () => {
        // Persist state before exiting
        try { savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(expanded) }); } catch (_) {}
        // Stop the OpenCode server if we started it
        opencodeClient.stopServer();
        screen.destroy();
        process.exit(0);
      });

      screen.key(['escape'], () => {
        // If a child handler just handled Escape, ignore this global
        // handler to avoid exiting the TUI unexpectedly.
        if (suppressEscapeUntil && Date.now() < suppressEscapeUntil) {
          return;
        }
        // Close any active overlays/panes in reverse-open order
        if (!nextDialog.hidden) {
          closeNextDialog();
          return;
        }
        if (!closeDialog.hidden) {
          closeCloseDialog();
          return;
        }
        if (!updateDialog.hidden) {
          closeUpdateDialog();
          return;
        }
        if (!opencodeDialog.hidden) {
          closeOpencodeDialog();
          return;
        }
        if (opencodePane) {
          closeOpencodePane();
          return;
        }
        if (!detailModal.hidden) {
          closeDetails();
          return;
        }
        if (helpMenu.isVisible()) {
          // If help overlay is visible, close it instead of quitting
          closeHelp();
          return;
        }
        try { savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(expanded) }); } catch (_) {}
        // Stop the OpenCode server if we started it
        opencodeClient.stopServer();
        screen.destroy();
        process.exit(0);
      });

      // Focus list to receive keys
      list.focus();
      paneFocusIndex = getFocusPanes().indexOf(list);
      applyFocusStyles();
      screen.render();

      function openHelp() {
        helpMenu.show();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
      }

      function closeHelp() {
        helpMenu.hide();
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
      }

      // Toggle help
       screen.key(['?'], () => {
         if (!helpMenu.isVisible()) openHelp();
         else closeHelp();
       });

       // Raw keypress handler for Ctrl-W sequences
       // This fires BEFORE screen.key() handlers and gives us lower-level control
       screen.on('keypress', (_ch: any, key: any) => {
         console.error(`[TUI] Raw keypress: ch="${_ch}", key.name="${key?.name}", key.ctrl=${key?.ctrl}, key.meta=${key?.meta}`);
         
         // Only process hjklwp when ctrlWPending is true
         if (ctrlWPending && ['h', 'j', 'k', 'l', 'w', 'p'].includes(key?.name)) {
           console.error(`[TUI] Raw handler: ctrlWPending is true and key is hjklwp, handling Ctrl-W command`);
           if (handleCtrlWCommand(key?.name)) {
             console.error(`[TUI] Raw handler: command handled, returning true to suppress further processing`);
             ctrlWPending = false;
             if (ctrlWTimeout) {
               clearTimeout(ctrlWTimeout);
               ctrlWTimeout = null;
             }
             // Set flag to suppress widget-level key handling
             lastCtrlWKeyHandled = true;
             setTimeout(() => { lastCtrlWKeyHandled = false; }, 100);
             
             // Set suppressNextP if we just handled Ctrl-W p
             if (key?.name === 'p') {
               suppressNextP = true;
               setTimeout(() => { suppressNextP = false; }, 100);
             }
             return false;  // Consume the event
           }
         }
       });

       // Vim-style window navigation with Ctrl-W sequence
       screen.key(['C-w'], (_ch: any, key: any) => {
         console.error(`[TUI] *** Screen handler for Ctrl-W fired (key.ctrl=${key?.ctrl}) ***`);
         if (helpMenu.isVisible()) return;
         if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
         console.error(`[TUI] Setting ctrlWPending and waiting for follow-up key`);
         setCtrlWPending();
       });

       screen.key(['h', 'j', 'k', 'l', 'w', 'p'], (_ch: any, key: any) => {
         console.error(`[TUI] *** Screen handler for hjklwp fired, key.name="${key?.name}", key.ctrl=${key?.ctrl}, ctrlWPending=${ctrlWPending} ***`);
         
         // Skip this handler if it's a Ctrl- modifier key (those go to Ctrl-W handler)
         if (key?.ctrl) {
           console.error(`[TUI] Skipping: key has ctrl modifier, letting Ctrl- handler deal with it`);
           return;
         }
         
         if (helpMenu.isVisible()) return;
         if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
         
         const result = handleCtrlWPendingKey(key?.name);
         console.error(`[TUI] handleCtrlWPendingKey returned ${result}`);
         return result;
       });


      // Open opencode prompt dialog (shortcut O)
      screen.key(['o', 'O'], async () => {
        if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden) {
          await openOpencodeDialog();
        }
      });

      // Copy selected ID
      screen.key(['c', 'C'], () => {
        copySelectedId();
      });

       // Open parent preview
       screen.key(['p', 'P'], () => {
         if (suppressNextP) {
           console.error(`[TUI] Suppressing 'p' handler (just handled Ctrl-W p)`);
           return;
         }
         openParentPreview();
       });

      // Close selected item
      screen.key(['x', 'X'], () => {
        if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden) {
          openCloseDialog();
        }
      });

      // Update selected item (quick edit) - shortcut U
      screen.key(['u', 'U'], () => {
        if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden) {
          openUpdateDialog();
        }
      });

      // Refresh from database
      screen.key(['r', 'R'], () => {
        refreshFromDatabase();
      });

      // Evaluate next item
      screen.key(['n', 'N'], () => {
        if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden && nextDialog.hidden) {
          openNextDialog();
        }
      });

      // Filter shortcuts
      screen.key(['i', 'I'], () => {
        setFilterNext('in-progress');
      });

      screen.key(['a', 'A'], () => {
        setFilterNext('open');
      });

      screen.key(['b', 'B'], () => {
        setFilterNext('blocked');
      });

      // Click footer to open help
      help.on('click', (data: any) => {
        try {
          const closedCount = items.filter((item: any) => item.status === 'completed' || item.status === 'deleted').length;
          const rightText = `Closed (${closedCount}): ${showClosed ? 'Shown' : 'Hidden'}`;
          const cols = screen.width as number;
          const rightStart = cols - rightText.length;
          const clickX = data?.x ?? 0;
          if (cols && clickX >= rightStart) {
            showClosed = !showClosed;
            rebuildTree();
            renderListAndDetail(list.selected as number);
            return;
          }
        } catch (err) {
          // ignore
        }
        openHelp();
      });

      copyIdButton.on('click', () => {
        copySelectedId();
      });

      closeOverlay.on('click', () => {
        closeCloseDialog();
      });

      closeDialogOptions.on('select', (_el: any, idx: number) => {
        if (idx === 0) closeSelectedItem('in_review');
        if (idx === 1) closeSelectedItem('done');
        if (idx === 2) closeSelectedItem('deleted');
        if (idx === 3) showToast('Cancelled');
        closeCloseDialog();
      });

      updateDialogOptions.on('select', (_el: any, idx: number) => {
        const item = getSelectedItem();
        if (!item) {
          showToast('No item selected');
          closeUpdateDialog();
          return;
        }
        try {
          if (idx === 0) db.update(item.id, { stage: 'idea' });
          else if (idx === 1) db.update(item.id, { stage: 'prd_complete' });
          else if (idx === 2) db.update(item.id, { stage: 'plan_complete' });
          else if (idx === 3) db.update(item.id, { stage: 'in_progress' });
          else if (idx === 4) db.update(item.id, { stage: 'in_review' });
          else if (idx === 5) db.update(item.id, { stage: 'done' });
          else if (idx === 6) db.update(item.id, { stage: 'blocked' });
          else if (idx === 7) { /* Cancel - no action */ }
          if (idx !== 7) showToast('Updated');
          else showToast('Cancelled');
          refreshFromDatabase(Math.max(0, (list.selected as number) - 0));
        } catch (err) {
          showToast('Update failed');
        }
        closeUpdateDialog();
      });

      updateDialog.key(['escape'], () => {
        closeUpdateDialog();
      });

      updateDialogOptions.key(['escape'], () => {
        closeUpdateDialog();
      });

      closeDialog.key(['escape'], () => {
        closeCloseDialog();
      });

      closeDialogOptions.key(['escape'], () => {
        closeCloseDialog();
      });

      nextDialog.key(['escape'], () => {
        closeNextDialog();
      });

      nextOverlay.on('click', () => {
        closeNextDialog();
      });

      nextDialogClose.on('click', () => {
        closeNextDialog();
      });

      nextDialogOptions.on('select', async (_el: any, idx: number) => {
        if (idx === 0) {
          if (!nextWorkItem || !nextWorkItem.id) {
            showToast(nextWorkItemRunning ? 'Still evaluating...' : 'No work item to view');
            return;
          }
          const selected = await viewWorkItemInTree(nextWorkItem.id);
          if (selected) closeNextDialog();
          return;
        }
        if (idx === 1) {
          closeNextDialog();
        }
      });

      nextDialogOptions.on('click', async () => {
        const idx = (nextDialogOptions as any).selected ?? 0;
        if (typeof (nextDialogOptions as any).emit === 'function') {
          (nextDialogOptions as any).emit('select item', null, idx);
          return;
        }
        if (idx === 0) {
          if (!nextWorkItem || !nextWorkItem.id) {
            showToast(nextWorkItemRunning ? 'Still evaluating...' : 'No work item to view');
            return;
          }
          const selected = await viewWorkItemInTree(nextWorkItem.id);
          if (selected) closeNextDialog();
          return;
        }
        if (idx === 1) {
          closeNextDialog();
        }
      });

      nextDialogOptions.on('select item', async (_el: any, idx: number) => {
        if (idx === 0) {
          if (!nextWorkItem || !nextWorkItem.id) {
            showToast(nextWorkItemRunning ? 'Still evaluating...' : 'No work item to view');
            return;
          }
          const selected = await viewWorkItemInTree(nextWorkItem.id);
          if (selected) closeNextDialog();
          return;
        }
        if (idx === 1) {
          closeNextDialog();
        }
      });

      nextDialogOptions.key(['escape'], () => {
        closeNextDialog();
      });

      detailOverlay.on('click', () => {
        closeDetails();
      });

      detailModal.key(['escape'], () => {
        closeDetails();
      });

      screen.on('mouse', (data: any) => {
        if (!data || !['mousedown', 'mouseup', 'click'].includes(data.action)) return;
        if (!detailModal.hidden && Date.now() < suppressDetailCloseUntil) return;
        if (!detailModal.hidden && !isInside(detailModal, data.x, data.y)) {
          closeDetails();
          return;
        }
        if (detailModal.hidden && !helpMenu.isVisible() && isInside(detail, data.x, data.y)) {
          if (data.action === 'click' || data.action === 'mousedown') {
            openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
          }
        }
      });
    });
}
