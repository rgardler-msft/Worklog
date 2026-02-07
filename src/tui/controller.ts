/**
 * TUI controller: composes TUI state, persistence, layout, handlers,
 * and OpenCode client wiring.
 */

import type { PluginContext } from '../plugin-types.js';
import type { WorkItem, WorkItemStatus } from '../types.js';
import type { ChildProcess } from 'child_process';
import blessed from 'blessed';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { humanFormatWorkItem, formatTitleOnlyTUI } from '../commands/helpers.js';
import { createTuiState, rebuildTreeState, buildVisibleNodes } from './state.js';
import { createPersistence } from './persistence.js';
import { resolveWorklogDir } from '../worklog-paths.js';
import { getDefaultDataPath } from '../jsonl.js';
import { createLayout } from './layout.js';
import { createUpdateDialogFocusManager } from './update-dialog-navigation.js';
import { buildUpdateDialogUpdates } from './update-dialog-submit.js';
import {
  getAllowedStagesForStatus,
  getAllowedStatusesForStage,
  isStatusStageCompatible,
} from './status-stage-validation.js';
import {
  STATUS_STAGE_COMPATIBILITY,
  STAGE_STATUS_COMPATIBILITY,
  WORK_ITEM_STATUSES,
  WORK_ITEM_STAGES,
} from './status-stage-rules.js';
import { OpencodeClient, type OpencodeServerStatus } from './opencode-client.js';

type Item = WorkItem;

// Lightweight, explicit interfaces to avoid wide `any` usage in the TUI code.
// These intentionally model the small surface area of blessed widgets used
// by this file rather than pulling in the entire blessed typeset so the
// runtime code and tests remain easy to mock.
type Pane = {
  focus?: () => void;
  hidden?: boolean;
  setFront?: () => void;
  hide?: () => void;
  show?: () => void;
  setItems?: (items: string[]) => void;
  select?: (idx: number) => void;
  getItem?: (idx: number) => { getContent?: () => string } | undefined;
  setContent?: (s: string) => void;
  setLabel?: (s: string) => void;
  width?: number | string;
  height?: number | string;
  style?: any;
  top?: number | string;
  left?: number | string;
  bottom?: number | string;
  on?: (event: string, cb: (...args: unknown[]) => void) => void;
  key?: (keys: string[] | string, cb: (...args: unknown[]) => void) => void;
  getValue?: () => string;
  clearValue?: () => void;
  setValue?: (v: string) => void;
  moveCursor?: (n: number) => void;
  pushLine?: (s: string) => void;
  setScroll?: (n: number) => void;
  setScrollPerc?: (n: number) => void;
  items?: any[];
};

type VisibleNode = { item: Item; depth: number; hasChildren: boolean };

type KeyInfo = { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean };

export interface TuiControllerDeps {
  blessed?: any;
  spawn?: (...args: any[]) => ChildProcess;
  fs?: typeof fs;
  path?: typeof path;
  resolveWorklogDir?: typeof resolveWorklogDir;
  createPersistence?: typeof createPersistence;
  createLayout?: typeof createLayout;
  OpencodeClient?: typeof OpencodeClient;
}

export class TuiController {
  constructor(
    private readonly ctx: PluginContext,
    private readonly deps: TuiControllerDeps = {}
  ) {}

  start(options: { inProgress?: boolean; prefix?: string; all?: boolean }): void {
    const { program, utils } = this.ctx;
    // Allow tests to inject a mocked blessed implementation via the ctx object.
    // If not provided, fall back to the real blessed import.
    const blessedImpl = this.deps.blessed ?? (this.ctx as any).blessed ?? blessed;
    const spawnImpl: (...args: any[]) => ChildProcess = this.deps.spawn ?? (this.ctx as any).spawn ?? spawn;
    const fsImpl = this.deps.fs ?? fs;
    const pathImpl = this.deps.path ?? path;
    const resolveWorklogDirImpl = this.deps.resolveWorklogDir ?? resolveWorklogDir;
    const createPersistenceImpl = this.deps.createPersistence ?? createPersistence;
    const createLayoutImpl = this.deps.createLayout ?? createLayout;
    const OpencodeClientImpl = this.deps.OpencodeClient ?? OpencodeClient;

    utils.requireInitialized();
    const db = utils.getDatabase(options.prefix);
    const isVerbose = !!program.opts().verbose;
    const debugLog = (message: string) => {
      if (!isVerbose) return;
      console.error(`[tui:opencode] ${message}`);
    };

    const query: Partial<Record<string, unknown>> = {};
    if (options.inProgress) query.status = 'in-progress';

    const items: Item[] = db.list(query);
    const showClosed = Boolean(options.all);

    // Persisted state handling extracted to src/tui/persistence.ts
    const persistence = createPersistenceImpl(resolveWorklogDirImpl(), { debugLog: debugLog, fs: fsImpl });
    const persisted = persistence.loadPersistedState(db.getPrefix?.() || undefined);
    const persistedExpanded = persisted && Array.isArray(persisted.expanded) ? persisted.expanded : undefined;
    const state = createTuiState(items, showClosed, persistedExpanded);

    // By default hide closed items (completed or deleted) unless --all is set
    if (state.currentVisibleItems.length === 0) {
      console.log('No work items found');
      return;
    }
    const rebuildTree = () => rebuildTreeState(state);

    // Active search/filter term and preserved items when a filter is applied
    let activeFilterTerm = '';
    let preFilterItems: Item[] | null = null;

    // Persisted state file per-worklog directory
    const worklogDir = resolveWorklogDirImpl();
    const statePath = pathImpl.join(worklogDir, 'tui-state.json');
    void statePath;

    // Load persisted state for this prefix if present
     // persistence.savePersistedState / loadPersistedState are provided by createPersistence

    // Default expand roots unless persisted state exists
    rebuildTree();
    if (!persistedExpanded) {
      for (const r of state.roots) state.expanded.add(r.id);
    }

     // Flatten visible nodes for rendering (uses module-level VisibleNode type)
    const buildVisible = () => buildVisibleNodes(state);

    // Setup blessed screen and layout via factory (extracted to src/tui/layout.ts)
    const layout = createLayoutImpl({ blessed: blessedImpl });
    const {
      screen,
      listComponent,
      detailComponent,
      toastComponent,
      overlaysComponent,
      dialogsComponent,
      helpMenu,
      modalDialogs,
      opencodeUi,
    } = layout;
    const list = listComponent.getList();
    const help = listComponent.getFooter();
    const detail = detailComponent.getDetail();
    const copyIdButton = detailComponent.getCopyIdButton();

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
    const updateDialogStageOptions = dialogsComponent.updateDialogStageOptions;
    const updateDialogStatusOptions = dialogsComponent.updateDialogStatusOptions;
    const updateDialogPriorityOptions = dialogsComponent.updateDialogPriorityOptions;
    const updateDialogComment = dialogsComponent.updateDialogComment;
    const updateDialogFieldOrder = [
      updateDialogStageOptions,
      updateDialogStatusOptions,
      updateDialogPriorityOptions,
      updateDialogComment,
    ];
    const updateDialogFieldLayout = [
      updateDialogStatusOptions,
      updateDialogStageOptions,
      updateDialogPriorityOptions,
      updateDialogComment,
    ];
    const updateDialogFocusManager = createUpdateDialogFocusManager(updateDialogFieldOrder);
    const updateDialogStatusValues = [...WORK_ITEM_STATUSES];
    const updateDialogStageValues = WORK_ITEM_STAGES.filter(stage => stage !== '');
    const updateDialogPriorityValues = ['critical', 'high', 'medium', 'low'];

    const normalizeStatusValue = (value: string | undefined) => {
      if (!value) return value;
      return value.replace(/_/g, '-');
    };

    const normalizeStageValue = (value: string | undefined) => {
      if (!value) return value;
      return value === 'Undefined' ? '' : value;
    };

    const getListItemValue = (list: Pane | undefined | null, fallback: string) => {
      const selectedIndex = (list as any)?.selected;
      if (selectedIndex === undefined) return fallback;
      const item = list?.getItem ? list.getItem(selectedIndex) : undefined;
      const content = item?.getContent ? item.getContent() : undefined;
      return content ?? fallback;
    };

    const buildStageItems = (allowed: readonly string[], item?: Item | null) => {
      const allowBlank = allowed.includes('') && (item?.stage === '' || allowed.length === 1);
      const filtered = allowed.filter(stage => stage !== '');
      if (allowBlank) return ['Undefined', ...filtered];
      if (filtered.length > 0) return filtered;
      return ['Undefined'];
    };

    const setListItems = (list: Pane | undefined | null, items: string[], preferred?: string) => {
      if (!list || typeof list.setItems !== 'function') return;
      list.setItems(items);
      const target = preferred && items.includes(preferred) ? preferred : items[0];
      if (target !== undefined && typeof list.select === 'function') {
        list.select(items.indexOf(target));
      }
    };

    const resetUpdateDialogItems = (item?: Item | null) => {
      updateDialogStatusOptions.setItems([...updateDialogStatusValues]);
      updateDialogPriorityOptions.setItems([...updateDialogPriorityValues]);
      const stageItems = item?.stage === ''
        ? ['Undefined', ...updateDialogStageValues]
        : [...updateDialogStageValues];
      updateDialogStageOptions.setItems(stageItems);
    };

    let updateDialogLastChanged: 'status' | 'stage' | 'priority' | null = null;
    let updateDialogItem: Item | null = null;
    let updateDialogApplying = false;

    const updateDialogHeader = (item: Item | null, overrides?: { status?: string; stage?: string; priority?: string; adjusted?: boolean }) => {
      if (!item) {
        updateDialogText.setContent('Update selected item fields:');
        return;
      }
      const statusValue = overrides?.status ?? normalizeStatusValue(item.status) ?? '';
      const stageValue = overrides?.stage ?? (item.stage === '' ? 'Undefined' : item.stage);
      const priorityValue = overrides?.priority ?? item.priority ?? '';
      const adjustedSuffix = overrides?.adjusted ? ' (Adjusted)' : '';
      updateDialogText.setContent(
        `Update: ${item.title}\nID: ${item.id}\nStatus: ${statusValue} · Stage: ${stageValue} · Priority: ${priorityValue}${adjustedSuffix}`
      );
    };

    const applyStatusStageCompatibility = (item?: Item | null) => {
      if (updateDialogApplying) return;
      updateDialogApplying = true;
      const complete = () => { updateDialogApplying = false; };
      const statusValue = getListItemValue(updateDialogStatusOptions, updateDialogStatusValues[0]);
      const stageValue = getListItemValue(updateDialogStageOptions, updateDialogStageValues[0]);
      const priorityValue = getListItemValue(updateDialogPriorityOptions, updateDialogPriorityValues[2]);

      const normalizedStageValue = normalizeStageValue(stageValue) ?? '';
      const allowedStages = getAllowedStagesForStatus(statusValue, {
        statusStage: STATUS_STAGE_COMPATIBILITY,
        stageStatus: STAGE_STATUS_COMPATIBILITY,
      });
      const allowedStatuses = getAllowedStatusesForStage(normalizedStageValue, {
        statusStage: STATUS_STAGE_COMPATIBILITY,
        stageStatus: STAGE_STATUS_COMPATIBILITY,
      });

      if (!updateDialogLastChanged) {
        if (item) {
          updateDialogHeader(item, {
            status: normalizeStatusValue(item.status),
            stage: item.stage === '' ? 'Undefined' : item.stage,
            priority: item.priority,
          });
        }
        updateDialogApplying = false;
        return;
      }

      try {
        if (updateDialogLastChanged === 'status') {
          const stageItems = buildStageItems(allowedStages, item);
          setListItems(updateDialogStageOptions, stageItems, stageValue);
        } else if (updateDialogLastChanged === 'stage') {
          const statusItems = allowedStatuses.length ? [...allowedStatuses] : updateDialogStatusValues;
          setListItems(updateDialogStatusOptions, statusItems, statusValue);
        }

        const currentStatus = getListItemValue(updateDialogStatusOptions, updateDialogStatusValues[0]);
        const currentStage = getListItemValue(updateDialogStageOptions, updateDialogStageValues[0]);
        const currentPriority = getListItemValue(updateDialogPriorityOptions, updateDialogPriorityValues[2]);
        const adjusted = currentStatus !== statusValue || currentStage !== stageValue;
        updateDialogHeader(item ?? null, {
          status: currentStatus,
          stage: currentStage,
          priority: currentPriority,
          adjusted,
        });
      } finally {
        complete();
      }
    };

    const applyUpdateDialogFocusStyles = (focused: Pane | undefined | null) => {
      updateDialogFieldOrder.forEach((list) => {
        if (!list || !list.style) return;
        if (!list.style.selected) list.style.selected = {};
        list.style.selected.bg = list === focused ? 'cyan' : 'blue';
        list.style.selected.fg = list === focused ? 'black' : 'white';
      });
      if (updateDialogComment && updateDialogComment.style && updateDialogComment.style.border) {
        updateDialogComment.style.border.fg = focused === updateDialogComment ? 'cyan' : 'gray';
      }
      if (!updateDialog.hidden) screen.render();
    };

    updateDialogFieldOrder.forEach((field) => {
      if (field && typeof field.on === 'function') {
        // Named focus/blur handlers so they can be removed if the field is destroyed
        const fieldFocusHandler = () => {
          applyUpdateDialogFocusStyles(field);
          if (!updateDialog.hidden) applyStatusStageCompatibility(getSelectedItem());
        };
        const fieldBlurHandler = () => {
          applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
          if (!updateDialog.hidden) applyStatusStageCompatibility(getSelectedItem());
        };
        try { (field as any).__opencode_focus = fieldFocusHandler; (field as any).__opencode_blur = fieldBlurHandler; field.on('focus', fieldFocusHandler); field.on('blur', fieldBlurHandler); } catch (_) {}
      }
    });

    const findListIndex = (values: string[], value: string | undefined, fallback: number) => {
      if (value === undefined) return fallback;
      const idx = values.indexOf(value);
      return idx >= 0 ? idx : fallback;
    };
    const wireUpdateDialogFieldNavigation = (field: Pane | undefined | null) => {
      if (!field || typeof field.key !== 'function') return;
      const fieldTabHandler = () => {
        if (updateDialog.hidden) return;
        updateDialogFocusManager.cycle(1);
        applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
        return false;
      };
      const fieldShiftTabHandler = () => {
        if (updateDialog.hidden) return;
        updateDialogFocusManager.cycle(-1);
        applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
        return false;
      };
      try { (field as any).__opencode_key_tab = fieldTabHandler; (field as any).__opencode_key_stab = fieldShiftTabHandler; field.key(['tab', 'C-i'], fieldTabHandler); field.key(['S-tab', 'C-S-i'], fieldShiftTabHandler); } catch (_) {}
      if (field === updateDialogComment && typeof field.on === 'function') {
        // Use a named handler so it can be removed if the field is destroyed
        const commentKeyHandler = (_ch: unknown, key: unknown) => {
          if (updateDialog.hidden) return;
          const k = key as KeyInfo | undefined;
          if (k?.name === 'tab') {
            updateDialogFocusManager.cycle(1);
            applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
            return;
          }
          if (k?.name === 'S-tab') {
            updateDialogFocusManager.cycle(-1);
            applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
            return;
          }
        };
        try { (field as any).__opencode_comment_key = commentKeyHandler; (field as any).on('keypress', commentKeyHandler); } catch (_) {}
        }
      const fieldLeftHandler = () => {
        if (updateDialog.hidden) return;
        const layoutIndex = updateDialogFieldLayout.indexOf(field as any);
        const nextIndex = layoutIndex <= 0 ? updateDialogFieldLayout.length - 1 : layoutIndex - 1;
        const target = updateDialogFieldLayout[nextIndex];
        updateDialogFocusManager.focusIndex(updateDialogFieldOrder.indexOf(target));
        applyUpdateDialogFocusStyles(target);
        return false;
      };
      const fieldRightHandler = () => {
        if (updateDialog.hidden) return;
        const layoutIndex = updateDialogFieldLayout.indexOf(field as any);
        const nextIndex = layoutIndex >= updateDialogFieldLayout.length - 1 ? 0 : layoutIndex + 1;
        const target = updateDialogFieldLayout[nextIndex];
        updateDialogFocusManager.focusIndex(updateDialogFieldOrder.indexOf(target));
        applyUpdateDialogFocusStyles(target);
        return false;
      };
      try { (field as any).__opencode_key_left = fieldLeftHandler; (field as any).__opencode_key_right = fieldRightHandler; field.key(['left'], fieldLeftHandler); field.key(['right'], fieldRightHandler); } catch (_) {}
    };

    [updateDialogStageOptions, updateDialogStatusOptions, updateDialogPriorityOptions, updateDialogComment]
      .forEach(wireUpdateDialogFieldNavigation);

    // (attachment of per-widget ctrl-w handlers moved to after opencodeText is defined)

    const handleUpdateDialogSelectionChange = (source?: 'status' | 'stage' | 'priority') => {
      updateDialogLastChanged = source ?? updateDialogLastChanged;
      if (!updateDialog.hidden) applyStatusStageCompatibility(updateDialogItem);
    };

    const wireUpdateDialogSelectionListeners = (list: Pane | undefined | null, source: 'status' | 'stage' | 'priority') => {
      if (!list || typeof list.on !== 'function') return;
      const selectHandler = () => handleUpdateDialogSelectionChange(source);
      const clickHandler = () => handleUpdateDialogSelectionChange(source);
      const keypressHandler = (...args: unknown[]) => {
        const key = args[1] as KeyInfo | undefined;
        if (!key?.name) return;
        if (['up', 'down', 'home', 'end', 'pageup', 'pagedown'].includes(key.name)) {
          handleUpdateDialogSelectionChange(source);
        }
      };
      try {
        (list as any)[`__opencode_select_${source}`] = selectHandler;
        (list as any)[`__opencode_click_${source}`] = clickHandler;
        (list as any)[`__opencode_keypress_${source}`] = keypressHandler;
        list.on('select', selectHandler);
        list.on('click', clickHandler);
        list.on('keypress', keypressHandler);
      } catch (_) {}
    };

    wireUpdateDialogSelectionListeners(updateDialogStatusOptions, 'status');
    wireUpdateDialogSelectionListeners(updateDialogStageOptions, 'stage');
    wireUpdateDialogSelectionListeners(updateDialogPriorityOptions, 'priority');

    // Next-dialog, help, modals, opencode — created by layout factory
    const nextOverlay = layout.nextDialog.overlay;
    const nextDialog = layout.nextDialog.dialog;
    const nextDialogClose = layout.nextDialog.close;
    const nextDialogText = layout.nextDialog.text;
    const nextDialogOptions = layout.nextDialog.options;

    const serverStatusBox = opencodeUi.serverStatusBox;
    const opencodeDialog = opencodeUi.dialog;
    const opencodeText = opencodeUi.textarea;
    const suggestionHint = opencodeUi.suggestionHint;
    const opencodeSend = opencodeUi.sendButton;
    const opencodeCancel = opencodeUi.cancelButton;

    // Attach widget-level ctrl-w pending handlers now that opencodeText exists.
    try {
      [list, detail, updateDialogStageOptions, updateDialogStatusOptions, updateDialogPriorityOptions, updateDialogComment, opencodeText]
        .forEach((w) => attachCtrlWPendingHandler(w as any));
    } catch (_) {}

    const setBorderFocusStyle = (element: Pane | undefined | null, focused: boolean) => {
      if (!element || !element.style) return;
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

    const paneForNode = (node: unknown): Pane | null => {
      if (!node) return null;
      if (node === list) return list as unknown as Pane;
      if (node === detail) return detail as unknown as Pane;
      if (node === opencodeDialog || node === opencodeText) return opencodeDialog as unknown as Pane;
      if (node === opencodePane) return opencodeDialog as unknown as Pane;
      return null;
    };
    let paneFocusIndex = 0;
    let lastPaneFocusIndex = 0;

    const getFocusPanes = (): Pane[] => {
      const panes: Pane[] = [list as unknown as Pane, detail as unknown as Pane];
      if (!opencodeDialog.hidden) panes.push(opencodeDialog as unknown as Pane);
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
        (opencodeText as Pane).focus?.();
      } else {
        (target as Pane).focus?.();
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
     let suppressNextPTimeout: ReturnType<typeof setTimeout> | null = null;
     let lastCtrlWKeyHandled = false;  // Flag to suppress widget key handling after Ctrl-W command
     let lastCtrlWKeyHandledTimeout: ReturnType<typeof setTimeout> | null = null;
     
      const setCtrlWPending = () => {
        debugLog(`Setting ctrlWPending = true (timestamp: ${Date.now()})`);
        ctrlWPending = true;
        lastCtrlWTime = Date.now();
        if (ctrlWTimeout) clearTimeout(ctrlWTimeout);
        ctrlWTimeout = setTimeout(() => {
          debugLog(`Clearing ctrlWPending (timeout)`);
          ctrlWPending = false;
          ctrlWTimeout = null;
        }, 2000);  // Increased to 2 seconds
      };

      const handleCtrlWCommand = (name?: string) => {
        debugLog(`handleCtrlWCommand(name="${name}")`);
        if (!name) return false;
        if (helpMenu.isVisible()) return false;
        if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return false;
        if (name === 'w') {
          debugLog(`Handling Ctrl-W w (cycleFocus)`);
          cycleFocus(1);
          screen.render();
          return true;
        }
        if (name === 'p') {
          debugLog(`Handling Ctrl-W p (previous pane)`);
          focusPaneByIndex(lastPaneFocusIndex);
          screen.render();
          return true;
        }
         if (name === 'h') {
           debugLog(`Handling Ctrl-W h (focus left with wrap)`);
           const current = getActivePaneIndex();
           focusPaneByIndex(current - 1);  // Cycle backward (wraps around)
           screen.render();
           return true;
         }
         if (name === 'l') {
           debugLog(`Handling Ctrl-W l (focus right with wrap)`);
           const current = getActivePaneIndex();
           focusPaneByIndex(current + 1);  // Cycle forward (wraps around)
           screen.render();
           return true;
         }
         if (name === 'k') {
           debugLog(`Handling Ctrl-W k (focus up/opencodePane)`);
            if (opencodeDialog.hidden) return false;
            if (!opencodePane || opencodePane.hidden) return false;
            (opencodePane as Pane).focus?.();
            syncFocusFromScreen();
            screen.render();
            return true;
         }
          if (name === 'j') {
            debugLog(`Handling Ctrl-W j (focus down/opencodeText)`);
             if (opencodeDialog.hidden) return false;
             if (!opencodePane || opencodePane.hidden) return false;
             (opencodeText as Pane).focus?.();
             syncFocusFromScreen();
             screen.render();
             return true;
          }
        debugLog(`handleCtrlWCommand: unrecognized key "${name}"`);
        return false;
      };

      const handleCtrlWPendingKey = (name?: string) => {
        debugLog(`handleCtrlWPendingKey(name="${name}", ctrlWPending=${ctrlWPending})`);
        if (!ctrlWPending) {
          debugLog(`ctrlWPending is false, ignoring key`);
          return false;
        }
        ctrlWPending = false;
        return handleCtrlWCommand(name);
      };

    const attachCtrlWPendingHandler = (widget: Pane | undefined | null) => {
        if (!widget || typeof widget.on !== 'function') return;
        // Attach a named handler so we can remove it later if the widget is destroyed
        const handler = (...args: unknown[]) => {
          const key = args[1] as KeyInfo | undefined;
          debugLog(`Widget keypress handler fired: key.name="${(key as any)?.name}", key.ctrl=${(key as any)?.ctrl}`);
          if (handleCtrlWPendingKey((key as any)?.name)) {
            debugLog(`Widget handler: handleCtrlWPendingKey returned true, consuming event`);
            return false;
          }
        };
        try {
          (widget as any).__opencode_ctrlw = handler;
          widget.on('keypress', handler);
        } catch (_) {}
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

    type OpencodeInputMode = 'insert' | 'normal';
    let opencodeInputMode: OpencodeInputMode = 'insert';
    let opencodeCursorIndex = 0;
    let opencodeDesiredColumn: number | null = null;

    const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    const getOpencodeValue = () => (opencodeText.getValue ? opencodeText.getValue() : '');

    const setOpencodeCursorIndex = (value: string, nextIndex: number) => {
      opencodeCursorIndex = clampNumber(nextIndex, 0, value.length);
      (opencodeText as any).__opencode_cursor = opencodeCursorIndex;
    };

    const setOpencodeInputMode = (mode: OpencodeInputMode) => {
      opencodeInputMode = mode;
      (opencodeText as any).__opencode_mode = opencodeInputMode;
      updateOpencodePromptLabel(isWaitingForResponse ? 'waiting' : 'idle');
    };

    const updateOpencodePromptLabel = (state: 'idle' | 'waiting') => {
      const modeSuffix = opencodeInputMode === 'normal' ? ' [normal]' : '';
      const stateSuffix = state === 'waiting' ? ' (waiting...)' : '';
      opencodeDialog.setLabel(` prompt${stateSuffix} [esc]${modeSuffix} `);
    };

    const getLineColumnFromIndex = (value: string, index: number) => {
      const clamped = clampNumber(index, 0, value.length);
      let line = 0;
      let column = 0;
      for (let i = 0; i < clamped; i += 1) {
        if (value[i] === '\n') {
          line += 1;
          column = 0;
        } else {
          column += 1;
        }
      }
      return { line, column };
    };

    const getIndexFromLineColumn = (value: string, line: number, column: number) => {
      const lines = value.split('\n');
      const safeLine = clampNumber(line, 0, Math.max(0, lines.length - 1));
      let idx = 0;
      for (let i = 0; i < safeLine; i += 1) {
        idx += lines[i].length + 1;
      }
      const col = clampNumber(column, 0, lines[safeLine]?.length ?? 0);
      return idx + col;
    };

    const moveOpencodeCursorHorizontal = (delta: number) => {
      const value = getOpencodeValue();
      setOpencodeCursorIndex(value, opencodeCursorIndex + delta);
      const { column } = getLineColumnFromIndex(value, opencodeCursorIndex);
      opencodeDesiredColumn = column;
      updateOpencodeCursor();
    };

    const moveOpencodeCursorVertical = (delta: number) => {
      const value = getOpencodeValue();
      const position = getLineColumnFromIndex(value, opencodeCursorIndex);
      const targetLine = position.line + delta;
      const desiredColumn = opencodeDesiredColumn ?? position.column;
      const nextIndex = getIndexFromLineColumn(value, targetLine, desiredColumn);
      setOpencodeCursorIndex(value, nextIndex);
      updateOpencodeCursor();
    };

    const opencodeTextBaseUpdateCursor = (opencodeText as any)._updateCursor?.bind(opencodeText);
    const opencodeTextUpdateCursor = function(this: any, get?: boolean) {
      if (this.screen?.focused !== this) return;
      const lpos = get ? this.lpos : this._getCoords?.();
      if (!lpos || !this.screen?.program) {
        opencodeTextBaseUpdateCursor?.(get);
        return;
      }
      if (!this._clines || !Array.isArray(this._clines) || !Array.isArray(this._clines.ftor)) {
        opencodeTextBaseUpdateCursor?.(get);
        return;
      }

      const value = typeof this.value === 'string' ? this.value : '';
      const { line, column } = getLineColumnFromIndex(value, opencodeCursorIndex);
      const wrappedIndexes: number[] = this._clines.ftor[line] ?? [];
      const fallbackIndex = Math.min(line, Math.max(0, this._clines.length - 1));
      const wrapped = wrappedIndexes.length ? wrappedIndexes : [fallbackIndex];

      let remaining = column;
      let wrappedIndex = wrapped[wrapped.length - 1] ?? fallbackIndex;
      let columnInWrapped = 0;

      for (const index of wrapped) {
        const text = (this._clines[index] ?? '').replace(/\x1b\[[0-9;]*m/g, '');
        const width = typeof this.strWidth === 'function' ? this.strWidth(text) : text.length;
        if (remaining <= width) {
          wrappedIndex = index;
          columnInWrapped = remaining;
          break;
        }
        remaining -= width;
      }

      if (wrappedIndex == null || wrappedIndex < 0) {
        opencodeTextBaseUpdateCursor?.(get);
        return;
      }

      const visibleLine = clampNumber(
        wrappedIndex - (this.childBase || 0),
        0,
        Math.max(0, (lpos.yl - lpos.yi) - this.iheight - 1)
      );
      const lineText = (this._clines[wrappedIndex] ?? '').replace(/\x1b\[[0-9;]*m/g, '');
      const colText = lineText.slice(0, columnInWrapped);
      const cxOffset = typeof this.strWidth === 'function' ? this.strWidth(colText) : colText.length;
      const cy = lpos.yi + this.itop + visibleLine;
      const cx = lpos.xi + this.ileft + cxOffset;
      const program = this.screen.program;

      if (cy === program.y && cx === program.x) return;
      if (cy === program.y) {
        if (cx > program.x) {
          program.cuf(cx - program.x);
        } else if (cx < program.x) {
          program.cub(program.x - cx);
        }
      } else if (cx === program.x) {
        if (cy > program.y) {
          program.cud(cy - program.y);
        } else if (cy < program.y) {
          program.cuu(program.y - cy);
        }
      } else {
        program.cup(cy, cx);
      }
    };
    try { (opencodeText as any)._updateCursor = opencodeTextUpdateCursor; } catch (_) {}

    const updateOpencodeCursor = () => {
      try { (opencodeText as any)._updateCursor?.(); } catch (_) {}
      screen.render();
    };

    function applyCommandSuggestion(target: any) {
      if (isCommandMode && currentSuggestion) {
        const nextValue = currentSuggestion + ' ';
        target.setValue(nextValue);
        setOpencodeCursorIndex(nextValue, nextValue.length);
        updateOpencodeCursor();
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
      const opencodeTextKeypressHandler = function(this: any, _ch: any, _key: any) {
        debugLog(`opencodeText keypress: _ch="${_ch}", key.name="${_key?.name}", key.ctrl=${_key?.ctrl}, lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);

        // Suppress j/k when they were just handled as Ctrl-W commands
        if (lastCtrlWKeyHandled && ['j', 'k'].includes(_key?.name)) {
          debugLog(`opencodeText: Suppressing '${_key?.name}' key (Ctrl-W command) - returning false`);
          return false;  // Consume the event
        }

        // ALSO check if we're in the middle of a Ctrl-W sequence
        if (ctrlWPending && ['j', 'k'].includes(_key?.name)) {
          debugLog(`opencodeText: ctrlWPending is true and key is j/k - consuming event to prevent typing`);
          return false;
        }

        // Handle Ctrl+Enter for newline insertion
        if (_key && _key.name === 'linefeed') {
          // Get CURRENT value BEFORE the textarea adds the newline
          const currentValue = this.getValue ? this.getValue() : '';
          const currentLines = currentValue.split('\n').length;

          // Calculate what the height WILL BE after the newline
          const futureLines = currentLines + 1;
          const desiredHeight = calculateOpencodeDesiredHeight(futureLines);

          // Resize the dialog FIRST
          applyOpencodeCompactLayout(desiredHeight);

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
      };
      try { (opencodeText as any).__opencode_keypress = opencodeTextKeypressHandler; (opencodeText as any).on('keypress', opencodeTextKeypressHandler); } catch (_) {}

    const opencodeTextInputHandler = function(this: any, ch: any, key: KeyInfo | undefined) {
      const value = typeof this.value === 'string' ? this.value : '';
      const name = key?.name;
      const hasCtrl = !!key?.ctrl;

      if (hasCtrl && name === 'n') {
        setOpencodeInputMode(opencodeInputMode === 'insert' ? 'normal' : 'insert');
        return true;
      }

      if (opencodeInputMode === 'normal') {
        if (name === 'i') {
          setOpencodeInputMode('insert');
          return true;
        }
        if (name === 'left' || name === 'h') {
          moveOpencodeCursorHorizontal(-1);
          return;
        }
        if (name === 'right' || name === 'l') {
          moveOpencodeCursorHorizontal(1);
          return;
        }
        if (name === 'up' || name === 'k') {
          moveOpencodeCursorVertical(-1);
          return;
        }
        if (name === 'down' || name === 'j') {
          moveOpencodeCursorVertical(1);
          return;
        }
        return true;
      }

      if (name === 'left') {
        moveOpencodeCursorHorizontal(-1);
        return true;
      }
      if (name === 'right') {
        moveOpencodeCursorHorizontal(1);
        return true;
      }
      if (name === 'up') {
        moveOpencodeCursorVertical(-1);
        return true;
      }
      if (name === 'down') {
        moveOpencodeCursorVertical(1);
        return true;
      }
      if (name === 'backspace') {
        if (opencodeCursorIndex > 0) {
          const nextValue = value.slice(0, opencodeCursorIndex - 1) + value.slice(opencodeCursorIndex);
          setOpencodeCursorIndex(nextValue, opencodeCursorIndex - 1);
          opencodeDesiredColumn = null;
          this.setValue?.(nextValue);
          screen.render();
        }
        return true;
      }
      if (name === 'delete') {
        if (opencodeCursorIndex < value.length) {
          const nextValue = value.slice(0, opencodeCursorIndex) + value.slice(opencodeCursorIndex + 1);
          setOpencodeCursorIndex(nextValue, opencodeCursorIndex);
          opencodeDesiredColumn = null;
          this.setValue?.(nextValue);
          screen.render();
        }
        return true;
      }
      if (name === 'enter') {
        return false;
      }

      const isLinefeed = name === 'linefeed';
      const insertChar = isLinefeed ? '\n' : (typeof ch === 'string' ? ch : '');
      if (!insertChar) return;
      if (/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar)) return;
      const nextValue = value.slice(0, opencodeCursorIndex) + insertChar + value.slice(opencodeCursorIndex);
      setOpencodeCursorIndex(nextValue, opencodeCursorIndex + insertChar.length);
      opencodeDesiredColumn = null;
      this.setValue?.(nextValue);
      screen.render();
      return true;
    };
      try { (opencodeText as any)._listener = opencodeTextInputHandler; } catch (_) {}



    // Active opencode pane/process tracking
    let opencodePane: any = null;

    const MIN_INPUT_HEIGHT = 3;  // Minimum height for input dialog (single line + borders)
    const MAX_INPUT_LINES = 7;   // Maximum visible lines of input text
    const FOOTER_HEIGHT = 1;
    const availableHeight = () => Math.max(10, (screen.height as number) - FOOTER_HEIGHT);
    const inputMaxHeight = () => Math.min(MAX_INPUT_LINES + 2, Math.floor(availableHeight() * 0.3)); // +2 for borders
    const paneHeight = () => Math.max(6, Math.floor(availableHeight() * 0.5));

    const ensureOpencodeTextStyle = () => {
      if (!opencodeText.style) {
        (opencodeText as any).style = {};
      }
    };

    const clearOpencodeTextBorders = () => {
      ensureOpencodeTextStyle();
      if (opencodeText.style.border) {
        Object.keys(opencodeText.style.border).forEach(key => {
          delete opencodeText.style.border[key];
        });
      }
      if (opencodeText.style.focus?.border) {
        Object.keys(opencodeText.style.focus.border).forEach(key => {
          delete opencodeText.style.focus.border[key];
        });
      }
    };

    const applyOpencodeCompactLayout = (desiredHeight: number) => {
      opencodeDialog.height = desiredHeight;

      (opencodeText as any).border = false;
      opencodeText.top = 0;
      opencodeText.left = 0;
      opencodeText.width = '100%-2';
      opencodeText.height = desiredHeight - 2;
      clearOpencodeTextBorders();

      if (opencodePane) {
        opencodePane.bottom = desiredHeight + FOOTER_HEIGHT;
        opencodePane.height = paneHeight();
      }
    };

    const calculateOpencodeDesiredHeight = (lines: number) => {
      return Math.min(Math.max(MIN_INPUT_HEIGHT, lines + 2), inputMaxHeight());
    };

    function updateOpencodeInputLayout() {
      if (!opencodeText.getValue) return;
      const value = opencodeText.getValue();
      const lines = value.split('\n').length;
      // Dialog height = content lines + 2 for borders
      const desiredHeight = calculateOpencodeDesiredHeight(lines);
      applyOpencodeCompactLayout(desiredHeight);
      screen.render();
    }

    async function openOpencodeDialog() {
      // Always use compact mode at bottom
      updateOpencodePromptLabel('idle');
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
      applyOpencodeCompactLayout(MIN_INPUT_HEIGHT);
      
      opencodeDialog.show();
      opencodeDialog.setFront();
      
      // Clear previous contents and focus textbox so typed characters appear
      try { if (typeof opencodeText.clearValue === 'function') opencodeText.clearValue(); } catch (_) {}
      try { if (typeof opencodeText.setValue === 'function') opencodeText.setValue(''); } catch (_) {}
      setOpencodeCursorIndex('', 0);
      
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
      setOpencodeCursorIndex('', 0);
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

    const opencodeClient = new OpencodeClientImpl({
      port: OPENCODE_SERVER_PORT,
      log: debugLog,
      showToast,
      modalDialogs,
      render: () => screen.render(),
      persistedState: {
        load: persistence.loadPersistedState,
        save: persistence.savePersistedState,
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
      updateOpencodePromptLabel('waiting');
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
          updateOpencodePromptLabel('idle');
          openOpencodeDialog();
          },
        });
      } catch (err) {
        // Clear flag on error too and restore label
        isWaitingForResponse = false;
        updateOpencodePromptLabel('idle');
        opencodePane.pushLine(`{red-fg}Server communication error: ${err}{/red-fg}`);
        screen.render();
      }
    }

    // Opencode dialog controls
    const opencodeSendClickHandler = () => {
      const prompt = opencodeText.getValue ? opencodeText.getValue() : '';
      closeOpencodeDialog();
      runOpencode(prompt);
    };
    try { (opencodeSend as any).__opencode_click = opencodeSendClickHandler; opencodeSend.on('click', opencodeSendClickHandler); } catch (_) {}

    // Add Escape key handler to close the opencode dialog
    const opencodeTextEscapeHandler = function(this: any) {
      opencodeDialog.hide();
      if (opencodePane) {
        opencodePane.hide();
      }
      list.focus();
      paneFocusIndex = getFocusPanes().indexOf(list);
      applyFocusStyles();
      screen.render();
    };
    try { (opencodeText as any).__opencode_key_escape = opencodeTextEscapeHandler; opencodeText.key(['escape'], opencodeTextEscapeHandler); } catch (_) {}

    // Accept Ctrl+S to send (keep for backward compatibility)
    const opencodeTextCSHandler = function(this: any) {
      if (applyCommandSuggestion(this)) {
        return;
      }
      const prompt = this.getValue ? this.getValue() : '';
      closeOpencodeDialog();
      runOpencode(prompt);
    };
    try { (opencodeText as any).__opencode_key_cs = opencodeTextCSHandler; opencodeText.key(['C-s'], opencodeTextCSHandler); } catch (_) {}

     // Accept Enter to send, Ctrl+Enter for newline
      const opencodeTextEnterHandler = function(this: any) {
        if (applyCommandSuggestion(this)) {
          return;
        }
        const prompt = this.getValue ? this.getValue() : '';
        closeOpencodeDialog();
        runOpencode(prompt);
      };
      try { (opencodeText as any).__opencode_key_enter = opencodeTextEnterHandler; opencodeText.key(['enter'], opencodeTextEnterHandler); } catch (_) {}

      // Suppress j/k keys when they're part of Ctrl-W commands
       const opencodeTextJHandler = function(this: any) {
         debugLog(`opencodeText.key(['j']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
         if (lastCtrlWKeyHandled) {
           debugLog(`opencodeText.key: Suppressing 'j' key (Ctrl-W command) - returning false`);
           return false;
         }
       };
       try { (opencodeText as any).__opencode_key_j = opencodeTextJHandler; opencodeText.key(['j'], opencodeTextJHandler); } catch (_) {}

      const opencodeTextKHandler = function(this: any) {
        debugLog(`opencodeText.key(['k']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
        if (lastCtrlWKeyHandled) {
          debugLog(`opencodeText.key: Suppressing 'k' key (Ctrl-W command) - returning false`);
          return false;
        }
      };
      try { (opencodeText as any).__opencode_key_k = opencodeTextKHandler; opencodeText.key(['k'], opencodeTextKHandler); } catch (_) {}


    // Pressing Escape while the dialog (or any child) is focused should
    // close both the input dialog and the response pane so the user returns
    // to the main list. Use a named handler so it can be removed during
    // cleanup in tests that repeatedly create/destroy dialogs.
    const opencodeDialogEscapeHandler = () => {
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
    };
    try { (opencodeDialog as any).__opencode_key_escape = opencodeDialogEscapeHandler; opencodeDialog.key(['escape'], opencodeDialogEscapeHandler); } catch (_) {}


    state.listLines = [];
    function renderListAndDetail(selectIndex = 0) {
      const visible = buildVisible();
      const lines = visible.map(n => {
        const indent = '  '.repeat(n.depth);
        const marker = n.hasChildren ? (state.expanded.has(n.item.id) ? '▾' : '▸') : ' ';
        const title = formatTitleOnlyTUI(n.item);
        return `${indent}${marker} ${title} {gray-fg}({underline}${n.item.id}{/underline}){/gray-fg}`;
      });
      state.listLines = lines;
      list.setItems(lines);
      // Keep selection in bounds
      const idx = Math.max(0, Math.min(selectIndex, lines.length - 1));
      list.select(idx);
      updateDetailForIndex(idx, visible);
      // Update footer/help with right-aligned closed toggle
      try {
        const closedCount = state.items.filter((item: any) => item.status === 'completed' || item.status === 'deleted').length;
        // Left side: show active filter if present (labelled "Filter:"), otherwise empty
        const leftText = activeFilterTerm ? `Filter: ${activeFilterTerm}` : '';
        // Right side: when closed items are hidden, show "-Closed (x)", otherwise show nothing
        const rightText = state.showClosed ? '' : `-Closed (${closedCount})`;
        const cols = screen.width as number;
        if (cols && leftText && rightText && cols > leftText.length + rightText.length + 2) {
          const gap = cols - leftText.length - rightText.length;
          help.setContent(`${leftText}${' '.repeat(gap)}${rightText}`);
        } else if (leftText && rightText) {
          help.setContent(`${leftText} • ${rightText}`);
        } else if (leftText) {
          help.setContent(leftText);
        } else if (rightText) {
          // Right-align the rightText by padding on the left
          if (cols && cols > rightText.length + 1) {
            const gap = cols - rightText.length;
            help.setContent(`${' '.repeat(gap)}${rightText}`);
          } else {
            help.setContent(rightText);
          }
        } else {
          help.setContent('');
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

    // Insert zero-width spaces into long uninterrupted tokens so blessed can
    // wrap extremely long words (e.g. long URLs or single-word reasons).
    // Using a zero-width space (U+200B) is intentional: it does not render
    // visually but allows terminals to break the word for wrapping.
    function softBreakLongWords(value: string, maxLen = 40): string {
      // Quick path
      if (!value || value.length <= maxLen) return value;
      // Match runs of non-whitespace characters at least maxLen long
      const re = new RegExp(`([^\\s]{${maxLen},})`, 'g');
      return value.replace(re, (match) => {
        const parts: string[] = [];
        for (let i = 0; i < match.length; i += maxLen) {
          parts.push(match.slice(i, i + maxLen));
        }
        // Use a zero-width space followed by a normal space as a fallback
        // so terminals that don't break on U+200B still have a visible
        // break opportunity. This keeps the visual impact minimal while
        // ensuring wrapping works across environments.
        return parts.join('\u200B ');
      });
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

    function stripTagsAndAnsiWithMap(value: string): { plain: string; map: number[] } {
      let plain = '';
      const map: number[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (ch === '\u001b') {
          let j = i + 1;
          if (value[j] === '[') {
            j += 1;
            while (j < value.length && !/[A-Za-z]/.test(value[j])) j += 1;
            if (j < value.length) j += 1;
          }
          i = j - 1;
          continue;
        }
        if (ch === '{') {
          const closeIdx = value.indexOf('}', i + 1);
          if (closeIdx !== -1) {
            i = closeIdx;
            continue;
          }
        }
        plain += ch;
        map.push(i);
      }
      return { plain, map };
    }

    function wrapPlainLineWithMap(plain: string, map: number[], width: number): Array<{ plain: string; map: number[] }> {
      if (width <= 0) return [{ plain, map }];
      const words = plain.split(/\s+/).filter(Boolean);
      if (words.length === 0) return [{ plain: '', map: [] }];
      const chunks: Array<{ plain: string; map: number[] }> = [];
      let current = '';
      let currentMap: number[] = [];
      let cursor = 0;
      for (const word of words) {
        const startIdx = plain.indexOf(word, cursor);
        if (startIdx === -1) continue;
        const wordMap = map.slice(startIdx, startIdx + word.length);
        cursor = startIdx + word.length;
        if (current.length === 0) {
          if (word.length <= width) {
            current = word;
            currentMap = wordMap.slice();
          } else {
            for (let i = 0; i < word.length; i += width) {
              const part = word.slice(i, i + width);
              const partMap = wordMap.slice(i, i + width);
              chunks.push({ plain: part, map: partMap });
            }
          }
          continue;
        }
        if ((current.length + 1 + word.length) <= width) {
          current += ` ${word}`;
          currentMap = currentMap.concat(-1, ...wordMap);
        } else {
          chunks.push({ plain: current, map: currentMap });
          if (word.length <= width) {
            current = word;
            currentMap = wordMap.slice();
          } else {
            for (let i = 0; i < word.length; i += width) {
              const part = word.slice(i, i + width);
              const partMap = wordMap.slice(i, i + width);
              chunks.push({ plain: part, map: partMap });
            }
            current = '';
            currentMap = [];
          }
        }
      }
      if (current.length > 0) {
        chunks.push({ plain: current, map: currentMap });
      }
      return chunks;
    }

    function getLineSegmentsForClick(box: any): Array<{ plain: string; map: number[] }> | null {
      if (!box?.lpos) return null;
      const raw = typeof box.getContent === 'function' ? String(box.getContent() ?? '') : '';
      const width = Math.max(0, (box.lpos.xl ?? 0) - (box.lpos.xi ?? 0) + 1);
      const segments: Array<{ plain: string; map: number[] }> = [];
      for (const line of raw.split('\n')) {
        const stripped = stripTagsAndAnsiWithMap(line);
        if (width > 0 && stripped.plain.length > width) {
          segments.push(...wrapPlainLineWithMap(stripped.plain, stripped.map, width));
        } else {
          segments.push({ plain: stripped.plain, map: stripped.map });
        }
      }
      return segments;
    }

    function getRenderedLineAtClick(box: any, data: any): string | null {
      const coords = getClickRow(box, data);
      if (!coords) return null;
      const scroll = typeof box.getScroll === 'function' ? (box.getScroll() as number) : 0;
      const segments = getLineSegmentsForClick(box);
      if (!segments) return null;
      const lineIndex = coords.row + (scroll || 0);
      const segment = segments[lineIndex];
      if (!segment) return null;
      return segment.plain ?? null;
    }

    function getRenderedLineAtScreen(box: any, data: any): string | null {
      const lpos = box?.lpos;
      if (!lpos) return null;
      const scroll = typeof box.getScroll === 'function' ? (box.getScroll() as number) : 0;
      const segments = getLineSegmentsForClick(box);
      if (!segments) return null;
      const base = (lpos.yi ?? 0);
      const offsets = [0, 1, 2, 3, -1, -2];
      for (const off of offsets) {
        const row = (data?.y ?? 0) - base - off;
        if (row < 0) continue;
        const lineIndex = row + (scroll || 0);
        if (lineIndex >= 0 && lineIndex < segments.length) return segments[lineIndex]?.plain ?? null;
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
      updateDialogItem = item ?? null;
      if (item) {
        resetUpdateDialogItems(item);
        updateDialogHeader(item, { status: normalizeStatusValue(item.status), stage: item.stage === '' ? 'Undefined' : item.stage, priority: item.priority });
        updateDialogStatusOptions.select(findListIndex(updateDialogStatusValues, normalizeStatusValue(item.status), 0));
        const selectedStage = item.stage === '' ? undefined : item.stage;
        updateDialogStageOptions.select(findListIndex(updateDialogStageValues, selectedStage, 0));
        updateDialogPriorityOptions.select(findListIndex(updateDialogPriorityValues, item.priority, 2));
        updateDialogLastChanged = null;
        applyStatusStageCompatibility(item);
      } else {
        updateDialogText.setContent('Update selected item fields:');
        resetUpdateDialogItems();
        updateDialogStatusOptions.select(0);
        updateDialogStageOptions.select(0);
        updateDialogPriorityOptions.select(2);
        updateDialogLastChanged = null;
        applyStatusStageCompatibility();
      }
      updateOverlay.show();
      updateDialog.show();
      updateOverlay.setFront();
      updateDialog.setFront();
        updateDialogFocusManager.focusIndex(0);
        updateDialogStageOptions.focus();
        applyUpdateDialogFocusStyles(updateDialogFieldOrder[0]);
      paneFocusIndex = getFocusPanes().indexOf(list);
      applyFocusStyles();
      screen.render();
    }

    function closeUpdateDialog() {
      updateDialog.hide();
      updateOverlay.hide();
      updateDialogItem = null;
      if (updateDialogComment?.setValue) {
        updateDialogComment.setValue('');
      }
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

    type ListRefreshOptions = {
      status?: 'in-progress' | 'blocked';
      includeClosed?: boolean;
      resetSearch?: boolean;
      updateOptions?: { inProgress: boolean; all: boolean };
      clearShowClosed?: boolean;
      preferredIndex?: number;
      fallbackIndex?: number;
      allowFallback?: boolean;
    };

    function refreshListWithOptions(opts: ListRefreshOptions = {}) {
      const {
        status,
        includeClosed = false,
        resetSearch = true,
        updateOptions,
        clearShowClosed = false,
        preferredIndex,
        fallbackIndex,
        allowFallback = true,
      } = opts;

      if (resetSearch) {
        activeFilterTerm = '';
        preFilterItems = null;
      }
      if (updateOptions) {
        options.inProgress = updateOptions.inProgress;
        options.all = updateOptions.all;
      }
      if (clearShowClosed) state.showClosed = false;

      const selected = getSelectedItem();
      const selectedId = selected?.id;
      const query: any = {};
      if (status) query.status = status;
      state.items = db.list(query);
      const nextVisible = includeClosed
        ? state.items.slice()
        : state.items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
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
        else if (allowFallback && typeof fallbackIndex === 'number') {
          nextIndex = Math.max(0, Math.min(fallbackIndex, visible.length - 1));
        }
      } else if (allowFallback && typeof fallbackIndex === 'number') {
        nextIndex = Math.max(0, Math.min(fallbackIndex, visible.length - 1));
      }
      renderListAndDetail(nextIndex);
    }

    function refreshFromDatabase(preferredIndex?: number, fallbackIndex?: number) {
      refreshListWithOptions({
        status: options.inProgress ? 'in-progress' : undefined,
        includeClosed: options.all,
        preferredIndex,
        fallbackIndex,
      });
    }

    const REFRESH_DEBOUNCE_MS = 300;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshFallbackIndex: number | null = null;
    let dataWatcher: fs.FSWatcher | null = null;
    let isShuttingDown = false;

    const scheduleRefreshFromDatabase = (fallbackIndex?: number) => {
      if (isShuttingDown) return;
      if (typeof fallbackIndex === 'number') {
        refreshFallbackIndex = fallbackIndex;
      }
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        const fallback = refreshFallbackIndex ?? undefined;
        refreshFallbackIndex = null;
        refreshFromDatabase(undefined, fallback);
      }, REFRESH_DEBOUNCE_MS);
    };

    const startDatabaseWatch = () => {
      if (typeof fsImpl.watch !== 'function') return;
      const dataPath = getDefaultDataPath();
      const dataDir = pathImpl.dirname(dataPath);
      const dataFile = pathImpl.basename(dataPath);
      try {
        dataWatcher = fsImpl.watch(dataDir, (eventType, filename) => {
          if (isShuttingDown) return;
          if (eventType !== 'change' && eventType !== 'rename') return;
          if (filename && filename !== dataFile) return;
          const selectedIndex = typeof list.selected === 'number' ? (list.selected as number) : 0;
          scheduleRefreshFromDatabase(selectedIndex);
        });
      } catch (_) {
        dataWatcher = null;
      }
    };

    const stopDatabaseWatch = () => {
      if (dataWatcher) {
        try { dataWatcher.close(); } catch (_) {}
        dataWatcher = null;
      }
    };

    function setFilterNext(filter: 'in-progress' | 'open' | 'blocked') {
      const status = filter === 'in-progress'
        ? 'in-progress'
        : filter === 'blocked'
          ? 'blocked'
          : undefined;
      const inProgress = filter === 'in-progress';
      refreshListWithOptions({
        status,
        includeClosed: false,
        updateOptions: { inProgress, all: false },
        clearShowClosed: true,
        allowFallback: false,
      });
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

      if (stage === 'deleted') {
        const args = ['--json', 'delete', item.id];
        if (options.prefix) {
          args.push('--prefix', options.prefix);
        }
        const child = spawnImpl('wl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr?.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', () => {
          showToast('Delete failed');
        });

        child.on('close', (code) => {
          if (code !== 0) {
            showToast(stderr.trim() || 'Delete failed');
            return;
          }

          try {
            const payload = JSON.parse(stdout.trim());
            if (!payload?.success) {
              showToast('Delete failed');
              return;
            }
          } catch (err) {
            showToast('Delete parse error');
            return;
          }

          showToast('Deleted');
          refreshFromDatabase(nextIndex);
        });
        return;
      }

      try {
        const updates = { status: 'completed' as const, stage };
        const compatible = isStatusStageCompatible(updates.status, updates.stage, {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        });
        if (!compatible) {
          showToast('Close blocked');
          return;
        }
        const updated = db.update(item.id, updates);
        if (!updated) {
          showToast('Close failed');
          return;
        }
        showToast(stage === 'done' ? 'Closed (done)' : 'Closed (in_review)');
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
    let nextWorkItems: Item[] = [];
    let nextWorkItemReasons: string[] = [];
    let nextWorkItemIndex = 0;

    function formatStageLabel(stage: string | undefined): string | null {
      if (stage === undefined) return null;
      if (stage === '') return 'Undefined';
      return stage;
    }

    function setNextDialogContent(content: string) {
      const safe = content;
      const baseWidth = 45;
      const firstLineWidth = Math.max(10, baseWidth - 4);

      const wrapPlainLine = (line: string, width: number): string[] => {
        const words = line.split(/\s+/).filter(Boolean);
        if (words.length === 0) return [''];
        const out: string[] = [];
        let current = '';
        for (const word of words) {
          if (current.length === 0) {
            if (word.length <= width) {
              current = word;
            } else {
              for (let i = 0; i < word.length; i += width) {
                out.push(word.slice(i, i + width));
              }
              current = '';
            }
            continue;
          }
          if ((current.length + 1 + word.length) <= width) {
            current = `${current} ${word}`;
          } else {
            out.push(current);
            if (word.length <= width) {
              current = word;
            } else {
              for (let i = 0; i < word.length; i += width) {
                out.push(word.slice(i, i + width));
              }
              current = '';
            }
          }
        }
        if (current.length > 0) out.push(current);
        return out;
      };

      const hasBlessedTags = (line: string) => /{[^}]+}/.test(line);

      const wrappedLines = safe.split('\n').flatMap((line, idx) => {
        const width = idx === 0 ? firstLineWidth : baseWidth;
        if (hasBlessedTags(line)) return [line];
        return wrapPlainLine(line, width);
      });

      nextDialogText.setContent(wrappedLines.join('\n'));
      try {
        // Count lines after wrapping (approximate by splitting on \n)
        const lines = wrappedLines.length;
        const screenH = typeof screen.height === 'number' ? screen.height : 24;
        const maxTextH = Math.max(3, Math.min(12, Math.floor(screenH * 0.4)));
        const textH = Math.min(Math.max(3, lines), maxTextH);
        // Keep options area (top 7 + height 3) visible — compute dialog height
        const optionsTop = 7;
        const optionsHeight = 3;
        const desiredDialogH = Math.min(screenH - 2, textH + optionsTop + optionsHeight - 1);
        nextDialogText.height = textH;
        nextDialog.height = desiredDialogH;
        // ensure the options list remains positioned below the text area
        try { nextDialogOptions.top = (nextDialogText.top as number) + (nextDialogText.height as number) + 1; } catch (_) {}
        // make text scrollable if content still exceeds the allocated height
        // Ensure scroll position reset so top of content is visible
        if (typeof (nextDialogText as any).setScroll === 'function') (nextDialogText as any).setScroll(0);
        if (typeof (nextDialogText as any).setScrollPerc === 'function') (nextDialogText as any).setScrollPerc(0);
      } catch (_) {
        // ignore layout errors and render content as-is
      }
      screen.render();
    }

    function resetNextDialogState() {
      nextWorkItem = null;
      nextWorkItemReason = '';
      nextWorkItems = [];
      nextWorkItemReasons = [];
      nextWorkItemIndex = 0;
    }

    function renderNextDialogItem(item: Item | null, reason: string, notice?: string) {
      if (!item) {
        const reasonLine = reason ? `\nReason: ${reason}` : '';
        setNextDialogContent(`No work item found.${reasonLine}`);
        return;
      }
      const stageLabel = formatStageLabel(item.stage);
      const lines = [
        `{bold}${item.title}{/bold}`,
        `ID: ${item.id}`,
        `Status: ${item.status}${stageLabel ? ` · Stage: ${stageLabel}` : ''}`,
        `Priority: ${item.priority || 'none'}`,
      ];
      if (reason) {
        lines.push('');
        lines.push(`Reason: ${reason}`);
      }
      if (notice) lines.push(`Note: ${notice}`);
      setNextDialogContent(lines.join('\n'));
    }

    function setNextWorkItemFromIndex(index: number, notice?: string) {
      nextWorkItemIndex = index;
      nextWorkItem = nextWorkItems[index] || null;
      nextWorkItemReason = nextWorkItemReasons[index] || '';
      renderNextDialogItem(nextWorkItem, nextWorkItemReason, notice);
    }

    function openNextDialog() {
      resetNextDialogState();
      nextDialogOptions.select(0);
      nextOverlay.show();
      nextDialog.show();
      nextOverlay.setFront();
      nextDialog.setFront();
      nextDialogOptions.focus();
      paneFocusIndex = getFocusPanes().indexOf(list);
      applyFocusStyles();
      setNextDialogContent('Evaluating next work item...');
      runNextWorkItems(0);
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

      if (state.itemsById.has(id)) {
        let cursor = state.itemsById.get(id) as Item | undefined;
        while (cursor?.parentId && state.itemsById.has(cursor.parentId)) {
          state.expanded.add(cursor.parentId);
          cursor = state.itemsById.get(cursor.parentId);
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

      state.showClosed = true;
      options.inProgress = false;
      options.all = true;
      state.items = db.list({}).filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
      rebuildTree();
      let refreshed = buildVisible();
      let refreshedIndex = refreshed.findIndex(node => node.item.id === id);
      if (refreshedIndex < 0 && state.itemsById.has(id)) {
        let cursor = state.itemsById.get(id) as Item | undefined;
        while (cursor?.parentId && state.itemsById.has(cursor.parentId)) {
          state.expanded.add(cursor.parentId);
          cursor = state.itemsById.get(cursor.parentId);
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

    function runNextWorkItems(targetIndex: number) {
      if (nextWorkItemRunning) return;
      nextWorkItemRunning = true;
      const count = Math.max(1, targetIndex + 1);
      const args = ['next', '--json', '--number', String(count)];
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

        const results = Array.isArray(payload.results)
          ? payload.results
          : [{ workItem: payload.workItem, reason: payload.reason }];

        const usable = results.filter((result: any) => result && result.workItem);
        nextWorkItems = usable.map((result: any) => result.workItem);
        nextWorkItemReasons = usable.map((result: any) => result.reason || '');

        if (nextWorkItems.length === 0) {
          const reason = payload.reason ? `\nReason: ${payload.reason}` : '';
          setNextDialogContent(`No work item found.${reason}`);
          return;
        }

        if (targetIndex >= nextWorkItems.length) {
          renderNextDialogItem(nextWorkItem, nextWorkItemReason, 'No further recommendations available.');
          return;
        }

        setNextWorkItemFromIndex(targetIndex);
      });
    }

    function advanceNextRecommendation() {
      if (nextWorkItemRunning) return;
      const nextIndex = nextWorkItemIndex + 1;
      runNextWorkItems(nextIndex);
    }

    // Initial render
    renderListAndDetail(0);

    // Event handlers (named so they can be removed during cleanup)
    // Centralized list selection handler to keep detail updates/rendering
    // consistent across mouse and keyboard interactions.
    const updateListSelection = (idx: number, source?: string) => {
      const visible = buildVisible();
      updateDetailForIndex(idx, visible);
      screen.render();
    };

    const listSelectHandler = (_el: any, idx: number) => {
      updateListSelection(idx, 'select');
    };
    try { (list as any).__opencode_select = listSelectHandler; list.on('select', listSelectHandler); } catch (_) {}

    // Update details immediately when navigating with keys or mouse
    const listKeypressHandler = (_ch: any, key: any) => {
      try {
        const nav = key && key.name && ['up', 'down', 'k', 'j', 'pageup', 'pagedown', 'home', 'end'].includes(key.name);
        if (nav) {
          const idx = list.selected as number;
          updateListSelection(idx, 'keypress');
        }
      } catch (err) {
        // ignore render errors
      }
    };
    try { (list as any).__opencode_keypress = listKeypressHandler; list.on('keypress', listKeypressHandler); } catch (_) {}

    const listFocusHandler = () => { paneFocusIndex = getFocusPanes().indexOf(list); applyFocusStylesForPane(list); };
    try { (list as any).__opencode_focus = listFocusHandler; list.on('focus', listFocusHandler); } catch (_) {}

    const detailFocusHandler = () => { paneFocusIndex = getFocusPanes().indexOf(detail); applyFocusStylesForPane(detail); };
    try { (detail as any).__opencode_focus = detailFocusHandler; detail.on('focus', detailFocusHandler); } catch (_) {}

    const opencodeDialogFocusHandler = () => { paneFocusIndex = getFocusPanes().indexOf(opencodeDialog); applyFocusStylesForPane(opencodeDialog); };
    try { (opencodeDialog as any).__opencode_focus = opencodeDialogFocusHandler; opencodeDialog.on('focus', opencodeDialogFocusHandler); } catch (_) {}

    const opencodeTextFocusHandler = () => { paneFocusIndex = getFocusPanes().indexOf(opencodeDialog); applyFocusStylesForPane(opencodeDialog); };
    try { (opencodeText as any).__opencode_focus = opencodeTextFocusHandler; opencodeText.on('focus', opencodeTextFocusHandler); } catch (_) {}

    // NOTE: List click-to-select is handled via screen.on('mouse') below,
    // because blessed routes mouse events to list *item* child elements
    // (which have higher z-index), so list.on('click') never fires.

    const detailClickHandler = (data: any) => {
      detail.focus();
      paneFocusIndex = getFocusPanes().indexOf(detail);
      applyFocusStylesForPane(detail);
      openDetailsFromClick(getRenderedLineAtClick(detail as any, data));
    };
    try { (detail as any).__opencode_click = detailClickHandler; detail.on('click', detailClickHandler); } catch (_) {}

    const detailModalClickHandler = (data: any) => {
      detailModal.focus();
      paneFocusIndex = getFocusPanes().indexOf(detail);
      applyFocusStylesForPane(detail);
      openDetailsFromClick(getRenderedLineAtClick(detailModal as any, data));
    };
    try { (detailModal as any).__opencode_click = detailModalClickHandler; detailModal.on('click', detailModalClickHandler); } catch (_) {}

    const detailMouseHandler = (data: any) => {
      if (data?.action === 'click') {
        detail.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtClick(detail as any, data));
      }
    };
    try { (detail as any).__opencode_mouse = detailMouseHandler; detail.on('mouse', detailMouseHandler); } catch (_) {}

    const detailMouseDownHandler = (data: any) => {
      detail.focus();
      paneFocusIndex = getFocusPanes().indexOf(detail);
      applyFocusStylesForPane(detail);
      openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
    };
    try { (detail as any).__opencode_mousedown = detailMouseDownHandler; detail.on('mousedown', detailMouseDownHandler); } catch (_) {}

    const detailMouseUpHandler = (data: any) => {
      detail.focus();
      paneFocusIndex = getFocusPanes().indexOf(detail);
      applyFocusStylesForPane(detail);
      openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
    };
    try { (detail as any).__opencode_mouseup = detailMouseUpHandler; detail.on('mouseup', detailMouseUpHandler); } catch (_) {}

    const detailModalMouseHandler = (data: any) => {
      if (data?.action === 'click') {
        detailModal.focus();
        paneFocusIndex = getFocusPanes().indexOf(detail);
        applyFocusStylesForPane(detail);
        openDetailsFromClick(getRenderedLineAtClick(detailModal as any, data));
      }
    };
    try { (detailModal as any).__opencode_mouse = detailModalMouseHandler; detailModal.on('mouse', detailModalMouseHandler); } catch (_) {}

    const detailCloseClickHandler = () => { closeDetails(); };
    try { (detailClose as any).__opencode_click = detailCloseClickHandler; detailClose.on('click', detailCloseClickHandler); } catch (_) {}

    screen.key(['right', 'enter'], () => {
      if (!updateDialog.hidden) return;
      const idx = list.selected as number;
      const visible = buildVisible();
      const node = visible[idx];
      if (node && node.hasChildren) {
        state.expanded.add(node.item.id);
        renderListAndDetail(idx);
      }
    });

    screen.key(['left'], () => {
      if (!updateDialog.hidden) return;
      const idx = list.selected as number;
      const visible = buildVisible();
      const node = visible[idx];
      if (!node) return;
      if (node.hasChildren && state.expanded.has(node.item.id)) {
        state.expanded.delete(node.item.id);
        renderListAndDetail(idx);
        return;
      }
      // collapse parent if possible
      const parentIdx = findParentIndex(idx, visible);
      if (parentIdx >= 0) {
        const parent = visible[parentIdx];
        state.expanded.delete(parent.item.id);
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
      if (state.expanded.has(node.item.id)) state.expanded.delete(node.item.id);
      else state.expanded.add(node.item.id);
      renderListAndDetail(idx);
      // persist state
      persistence.savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(state.expanded) });
    });

    const shutdown = () => {
      isShuttingDown = true;
      // Persist state before exiting
      try { persistence.savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(state.expanded) }); } catch (_) {}
      stopDatabaseWatch();
      // Stop the OpenCode server if we started it
      opencodeClient.stopServer();
      // Clear pending timers to avoid keeping the process alive
      if (ctrlWTimeout) {
        try { clearTimeout(ctrlWTimeout); } catch (_) {}
        ctrlWTimeout = null;
      }
      if (refreshTimer) {
        try { clearTimeout(refreshTimer); } catch (_) {}
        refreshTimer = null;
      }
      if (lastCtrlWKeyHandledTimeout) {
        try { clearTimeout(lastCtrlWKeyHandledTimeout); } catch (_) {}
        lastCtrlWKeyHandledTimeout = null;
      }
      if (suppressNextPTimeout) {
        try { clearTimeout(suppressNextPTimeout); } catch (_) {}
        suppressNextPTimeout = null;
      }
      screen.destroy();
    };

    // Quit keys: q and Ctrl-C always quit; Escape should close the help overlay
    // when it's open instead of exiting the whole TUI.
    screen.key(['q', 'C-c'], () => {
      shutdown();
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
      shutdown();
    });

    // Focus list to receive keys
    list.focus();
    paneFocusIndex = getFocusPanes().indexOf(list);
    applyFocusStyles();
    screen.render();

    startDatabaseWatch();

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
        debugLog(`Raw keypress: ch="${_ch}", key.name="${key?.name}", key.ctrl=${key?.ctrl}, key.meta=${key?.meta}`);
        
        // Only process hjklwp when ctrlWPending is true
        if (ctrlWPending && ['h', 'j', 'k', 'l', 'w', 'p'].includes(key?.name)) {
          debugLog(`Raw handler: ctrlWPending is true and key is hjklwp, handling Ctrl-W command`);
          if (handleCtrlWCommand(key?.name)) {
            debugLog(`Raw handler: command handled, returning true to suppress further processing`);
            ctrlWPending = false;
            if (ctrlWTimeout) {
              clearTimeout(ctrlWTimeout);
              ctrlWTimeout = null;
            }
            // Set flag to suppress widget-level key handling
            lastCtrlWKeyHandled = true;
            if (lastCtrlWKeyHandledTimeout) clearTimeout(lastCtrlWKeyHandledTimeout);
            lastCtrlWKeyHandledTimeout = setTimeout(() => { lastCtrlWKeyHandled = false; }, 100);
            
            // Set suppressNextP if we just handled Ctrl-W p
            if (key?.name === 'p') {
              suppressNextP = true;
              if (suppressNextPTimeout) clearTimeout(suppressNextPTimeout);
              suppressNextPTimeout = setTimeout(() => { suppressNextP = false; }, 100);
            }
            return false;  // Consume the event
          }
        }
      });

      // Vim-style window navigation with Ctrl-W sequence
      screen.key(['C-w'], (_ch: any, key: any) => {
        debugLog(`Screen handler for Ctrl-W fired (key.ctrl=${key?.ctrl})`);
        if (helpMenu.isVisible()) return;
        if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
        debugLog(`Setting ctrlWPending and waiting for follow-up key`);
        setCtrlWPending();
      });

      screen.key(['h', 'j', 'k', 'l', 'w', 'p'], (_ch: any, key: any) => {
        debugLog(`Screen handler for hjklwp fired, key.name="${key?.name}", key.ctrl=${key?.ctrl}, ctrlWPending=${ctrlWPending}`);
        
        // Skip this handler if it's a Ctrl- modifier key (those go to Ctrl-W handler)
        if (key?.ctrl) {
          debugLog(`Skipping: key has ctrl modifier, letting Ctrl- handler deal with it`);
          return;
        }
        
        if (helpMenu.isVisible()) return;
        if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
        
        const result = handleCtrlWPendingKey(key?.name);
        debugLog(`handleCtrlWPendingKey returned ${result}`);
        return result;
      });


    // Open opencode prompt dialog (shortcut O)
    screen.key(['o', 'O'], async () => {
      if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden) {
        await openOpencodeDialog();
      }
    });

    const restoreListFocus = () => {
      try {
        list.focus();
        paneFocusIndex = getFocusPanes().indexOf(list);
        applyFocusStyles();
        screen.render();
      } catch (_) {}
    };

    const resetInputState = () => {
      try { modalDialogs.forceCleanup?.(); } catch (_) {}
      restoreListFocus();
    };

    // Open search/filter modal (shortcut /)
    screen.key(['/'], async () => {
      if (!detailModal.hidden || helpMenu.isVisible() || !closeDialog.hidden || !updateDialog.hidden || !nextDialog.hidden) return;
      try {
        const term = await modalDialogs.editTextarea({
          title: 'Filter items',
          initial: activeFilterTerm || '',
          confirmLabel: 'Apply',
          cancelLabel: 'Cancel',
          width: '50%',
          height: 5,
        });

        const trimmed = (term || '').trim();
        if (!trimmed) {
          // Clear filter — restore original items
          activeFilterTerm = '';
          if (preFilterItems) {
            state.items = preFilterItems.slice();
            preFilterItems = null;
            rebuildTree();
            renderListAndDetail(0);
          } else {
            refreshListWithOptions({
              status: options.inProgress ? 'in-progress' : undefined,
              includeClosed: options.all,
              resetSearch: false,
              preferredIndex: 0,
              allowFallback: false,
            });
          }
          restoreListFocus();
          return;
        }

        // Apply filter by running `wl list <term> --json`
        activeFilterTerm = trimmed;
        if (!preFilterItems) preFilterItems = state.items.slice();

        const args = ['list', trimmed, '--json'];
        if (options.prefix) {
          args.push('--prefix', options.prefix);
        }
        const child = spawnImpl('wl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('close', (code) => {
          if (code !== 0) {
            showToast('Filter failed');
            restoreListFocus();
            return;
          }
          try {
            const payload = JSON.parse(stdout.trim());
            let results: any[] = [];
            if (Array.isArray(payload)) results = payload;
            else if (Array.isArray(payload.results)) results = payload.results;
            else if (Array.isArray(payload.workItems)) results = payload.workItems;
            else if (payload.workItem) results = [payload.workItem];

            state.items = results.length === 0
              ? []
              : results.map((r: any) => r.workItem ? r.workItem : r);
            state.showClosed = false;
            rebuildTree();
            renderListAndDetail(0);
          } catch (err) {
            showToast('Filter parse error');
          }
          restoreListFocus();
        });
      } catch (err) {
        // Modal was cancelled or errored — ensure focus returns to main list
        resetInputState();
      }
    });

    // Copy selected ID
    screen.key(['c', 'C'], () => {
      copySelectedId();
    });

      // Open parent preview
      screen.key(['p', 'P'], () => {
        if (suppressNextP) {
          debugLog(`Suppressing 'p' handler (just handled Ctrl-W p)`);
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
    const helpClickHandler = (data: any) => {
      try {
        const closedCount = state.items.filter((item: any) => item.status === 'completed' || item.status === 'deleted').length;
        const rightText = `Closed (${closedCount}): ${state.showClosed ? 'Shown' : 'Hidden'}`;
        const cols = screen.width as number;
        const rightStart = cols - rightText.length;
        const clickX = data?.x ?? 0;
        if (cols && clickX >= rightStart) {
          state.showClosed = !state.showClosed;
          rebuildTree();
          renderListAndDetail(list.selected as number);
          return;
        }
      } catch (err) {
        // ignore
      }
      openHelp();
    };
    try { (help as any).__opencode_click = helpClickHandler; help.on('click', helpClickHandler); } catch (_) {}

    const copyIdButtonClickHandler = () => { copySelectedId(); };
    try { (copyIdButton as any).__opencode_click = copyIdButtonClickHandler; copyIdButton.on('click', copyIdButtonClickHandler); } catch (_) {}

    const closeOverlayClickHandler = () => { closeCloseDialog(); };
    try { (closeOverlay as any).__opencode_click = closeOverlayClickHandler; closeOverlay.on('click', closeOverlayClickHandler); } catch (_) {}

    closeDialogOptions.on('select', (_el: any, idx: number) => {
      if (idx === 0) closeSelectedItem('in_review');
      if (idx === 1) closeSelectedItem('done');
      if (idx === 2) closeSelectedItem('deleted');
      if (idx === 3) showToast('Cancelled');
      closeCloseDialog();
    });

    updateDialogOptions.on('select', (_el: any, idx: number) => {
      void idx;
    });

    const updateDialogEscapeHandler = () => { closeUpdateDialog(); };
    try { (updateDialog as any).__opencode_key_escape = updateDialogEscapeHandler; updateDialog.key(['escape'], updateDialogEscapeHandler); } catch (_) {}

    const updateDialogOptionsEscapeHandler = () => { closeUpdateDialog(); };
    try { (updateDialogOptions as any).__opencode_key_escape = updateDialogOptionsEscapeHandler; updateDialogOptions.key(['escape'], updateDialogOptionsEscapeHandler); } catch (_) {}

    const updateDialogCommentEscapeHandler = () => { closeUpdateDialog(); };
    try { (updateDialogComment as any).__opencode_key_escape = updateDialogCommentEscapeHandler; updateDialogComment.key(['escape'], updateDialogCommentEscapeHandler); } catch (_) {}

    const updateDialogCommentEnterHandler = () => {
      if (updateDialog.hidden) return;
      submitUpdateDialog();
      return false;
    };
    try { (updateDialogComment as any).__opencode_key_enter = updateDialogCommentEnterHandler; updateDialogComment.key(['enter'], updateDialogCommentEnterHandler); } catch (_) {}

    const updateDialogCommentLinefeedHandler = () => {
      if (updateDialog.hidden) return;
      const currentValue = updateDialogComment.getValue ? updateDialogComment.getValue() : '';
      const nextValue = `${currentValue}\n`;
      updateDialogComment.setValue?.(nextValue);
      if (typeof updateDialogComment.moveCursor === 'function') {
        updateDialogComment.moveCursor(nextValue.length);
      }
      screen.render();
      return false;
    };
    try { (updateDialogComment as any).__opencode_key_linefeed = updateDialogCommentLinefeedHandler; updateDialogComment.key(['linefeed', 'C-j'], updateDialogCommentLinefeedHandler); } catch (_) {}

    const submitUpdateDialog = () => {
      const item = getSelectedItem();
      if (!item) {
        showToast('No item selected');
        closeUpdateDialog();
        return;
      }

      const statusIndex = (updateDialogStatusOptions as any).selected ?? 0;
      const stageIndex = (updateDialogStageOptions as any).selected ?? 0;
      const priorityIndex = (updateDialogPriorityOptions as any).selected ?? 2;

      const listItemsToValues = (list: any, map?: (value: string) => string) => {
        const items = list.items?.map((node: any) => node.getContent?.()) || [];
        const values = items.map((value: string) => (map ? map(value) : value));
        return values.filter((value: string) => value !== undefined);
      };
      const statusValues = listItemsToValues(updateDialogStatusOptions);
      const stageValues = listItemsToValues(updateDialogStageOptions, (value) => (value === 'Undefined' ? '' : value));
      const priorityValues = listItemsToValues(updateDialogPriorityOptions);

      const commentValue = updateDialogComment?.getValue ? updateDialogComment.getValue() : '';
      const { updates, hasChanges, comment } = buildUpdateDialogUpdates(
        item,
        { statusIndex, stageIndex, priorityIndex },
        {
          statuses: statusValues,
          stages: stageValues,
          priorities: priorityValues,
        },
        {
          statusStage: STATUS_STAGE_COMPATIBILITY,
          stageStatus: STAGE_STATUS_COMPATIBILITY,
        },
        commentValue
      );

      try {
        if (!hasChanges && !comment) {
          showToast('No changes');
          closeUpdateDialog();
          return;
        }
        if (Object.keys(updates).length > 0) {
          db.update(item.id, updates);
        }
        if (comment) {
          db.createComment({ workItemId: item.id, comment, author: '@tui' });
        }
        showToast('Updated');
        refreshFromDatabase(Math.max(0, (list.selected as number) - 0));
      } catch (err) {
        showToast('Update failed');
      }

      closeUpdateDialog();
    };

    const updateDialogEnterHandler = () => { if (updateDialog.hidden) return; submitUpdateDialog(); };
    try { (updateDialog as any).__opencode_key_enter = updateDialogEnterHandler; updateDialog.key(['enter'], updateDialogEnterHandler); } catch (_) {}

    const updateDialogCSHandler = () => { if (updateDialog.hidden) return; submitUpdateDialog(); };
    try { (updateDialog as any).__opencode_key_cs = updateDialogCSHandler; updateDialog.key(['C-s'], updateDialogCSHandler); } catch (_) {}

    const updateDialogStatusEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogStatusOptions as any).__opencode_key_enter = updateDialogStatusEnterHandler; updateDialogStatusOptions.key(['enter'], updateDialogStatusEnterHandler); } catch (_) {}

    const updateDialogStageEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogStageOptions as any).__opencode_key_enter = updateDialogStageEnterHandler; updateDialogStageOptions.key(['enter'], updateDialogStageEnterHandler); } catch (_) {}

    const updateDialogPriorityEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogPriorityOptions as any).__opencode_key_enter = updateDialogPriorityEnterHandler; updateDialogPriorityOptions.key(['enter'], updateDialogPriorityEnterHandler); } catch (_) {}

    const updateDialogTabHandler = () => { if (updateDialog.hidden) return; updateDialogFocusManager.cycle(1); };
    try { (updateDialog as any).__opencode_key_tab = updateDialogTabHandler; updateDialog.key(['tab'], updateDialogTabHandler); } catch (_) {}

    const updateDialogSTabHandler = () => { if (updateDialog.hidden) return; updateDialogFocusManager.cycle(-1); };
    try { (updateDialog as any).__opencode_key_stab = updateDialogSTabHandler; updateDialog.key(['S-tab'], updateDialogSTabHandler); } catch (_) {}

    const closeDialogEscapeHandler = () => { closeCloseDialog(); };
    try { (closeDialog as any).__opencode_key_escape = closeDialogEscapeHandler; closeDialog.key(['escape'], closeDialogEscapeHandler); } catch (_) {}

    const closeDialogOptionsEscapeHandler = () => { closeCloseDialog(); };
    try { (closeDialogOptions as any).__opencode_key_escape = closeDialogOptionsEscapeHandler; closeDialogOptions.key(['escape'], closeDialogOptionsEscapeHandler); } catch (_) {}

    const nextDialogEscapeHandler = () => { closeNextDialog(); };
    try { (nextDialog as any).__opencode_key_escape = nextDialogEscapeHandler; nextDialog.key(['escape'], nextDialogEscapeHandler); } catch (_) {}

    const nextOverlayClickHandler = () => { closeNextDialog(); };
    try { (nextOverlay as any).__opencode_click = nextOverlayClickHandler; nextOverlay.on('click', nextOverlayClickHandler); } catch (_) {}

    const nextDialogCloseClickHandler = () => { closeNextDialog(); };
    try { (nextDialogClose as any).__opencode_click = nextDialogCloseClickHandler; nextDialogClose.on('click', nextDialogCloseClickHandler); } catch (_) {}

    const nextDialogOptionsSelectHandler = async (_el: any, idx: number) => {
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
        advanceNextRecommendation();
        return;
      }
      if (idx === 2) {
        closeNextDialog();
      }
    };
    try { (nextDialogOptions as any).__opencode_select = nextDialogOptionsSelectHandler; nextDialogOptions.on('select', nextDialogOptionsSelectHandler); } catch (_) {}

    const nextDialogOptionsClickHandler = async () => {
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
        advanceNextRecommendation();
        return;
      }
      if (idx === 2) {
        closeNextDialog();
      }
    };
    try { (nextDialogOptions as any).__opencode_click = nextDialogOptionsClickHandler; nextDialogOptions.on('click', nextDialogOptionsClickHandler); } catch (_) {}

    const nextDialogOptionsSelectItemHandler = async (_el: any, idx: number) => {
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
        advanceNextRecommendation();
        return;
      }
      if (idx === 2) {
        closeNextDialog();
      }
    };
    try { (nextDialogOptions as any).__opencode_select_item = nextDialogOptionsSelectItemHandler; nextDialogOptions.on('select item', nextDialogOptionsSelectItemHandler); } catch (_) {}

    const nextDialogOptionsNHandler = () => { if (nextDialog.hidden) return; advanceNextRecommendation(); };
    try { (nextDialogOptions as any).__opencode_key_n = nextDialogOptionsNHandler; nextDialogOptions.key(['n', 'N'], nextDialogOptionsNHandler); } catch (_) {}

    const nextDialogOptionsEscapeHandler = () => { closeNextDialog(); };
    try { (nextDialogOptions as any).__opencode_key_escape = nextDialogOptionsEscapeHandler; nextDialogOptions.key(['escape'], nextDialogOptionsEscapeHandler); } catch (_) {}

    const detailOverlayClickHandler = () => { closeDetails(); };
    try { (detailOverlay as any).__opencode_click = detailOverlayClickHandler; detailOverlay.on('click', detailOverlayClickHandler); } catch (_) {}

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
      // List click-to-select: blessed routes mouse events to list item child
      // elements so list.on('click') never fires. Handle it at screen level.
      if (data.action === 'mousedown' && isInside(list, data.x, data.y)) {
        const coords = getClickRow(list as any, data);
        if (coords && coords.row >= 0) {
          const scroll = (list as any).childBase ?? 0;
          const lineIndex = coords.row + scroll;
          if (lineIndex >= 0 && lineIndex < state.listLines.length) {
            if (typeof list.select === 'function') list.select(lineIndex);
            updateListSelection(lineIndex, 'screen-mouse');
            list.focus();
            paneFocusIndex = getFocusPanes().indexOf(list);
            applyFocusStylesForPane(list);
          }
        }
      }
      if (detailModal.hidden && !helpMenu.isVisible() && isInside(detail, data.x, data.y)) {
        if (data.action === 'click' || data.action === 'mousedown') {
          openDetailsFromClick(getRenderedLineAtScreen(detail as any, data));
        }
      }
    });
  }
}
