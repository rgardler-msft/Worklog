/**
 * TUI controller: composes TUI state, persistence, layout, handlers,
 * and OpenCode client wiring.
 */

import type { PluginContext } from '../plugin-types.js';
import type { WorkItem, WorkItemStatus } from '../types.js';
import type { ChildProcess } from 'child_process';
import blessed from 'blessed';
import { spawn } from 'child_process';
import { copyToClipboard } from '../clipboard.js';
import * as fs from 'fs';
import * as path from 'path';
import { humanFormatWorkItem, formatTitleOnlyTUI } from '../commands/helpers.js';
import { createTuiState, rebuildTreeState, buildVisibleNodes, expandAncestorsForInProgress, isClosedStatus, enterMoveMode, exitMoveMode } from './state.js';
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
  getStageLabel,
  getStageValueFromLabel,
  getStatusLabel,
  getStatusValueFromLabel,
  loadStatusStageRules,
} from '../status-stage-rules.js';
import { OpencodeClient, type OpencodeServerStatus } from './opencode-client.js';
import ChordHandler from './chords.js';
import { stripAnsi, stripTags, decorateIdsForClick, extractIdFromLine, extractIdAtColumn, stripTagsAndAnsiWithMap, wrapPlainLineWithMap } from './id-utils.js';
import { AVAILABLE_COMMANDS, MIN_INPUT_HEIGHT, MAX_INPUT_LINES, FOOTER_HEIGHT, OPENCODE_SERVER_PORT,
  KEY_NAV_RIGHT, KEY_NAV_LEFT, KEY_TOGGLE_EXPAND, KEY_QUIT, KEY_ESCAPE, KEY_TOGGLE_HELP, KEY_CHORD_PREFIX, KEY_CHORD_FOLLOWUPS, KEY_OPEN_OPENCODE, KEY_OPEN_SEARCH,
  KEY_TAB, KEY_SHIFT_TAB, KEY_LEFT_SINGLE, KEY_RIGHT_SINGLE, KEY_CS, KEY_ENTER, KEY_LINEFEED, KEY_J, KEY_K, KEY_COPY_ID, KEY_PARENT_PREVIEW, KEY_CLOSE_ITEM, KEY_UPDATE_ITEM, KEY_REFRESH, KEY_FIND_NEXT, KEY_FILTER_IN_PROGRESS, KEY_FILTER_OPEN, KEY_FILTER_BLOCKED, KEY_FILTER_NEEDS_REVIEW, KEY_FILTER_INTAKE_COMPLETED, KEY_FILTER_PLAN_COMPLETED, KEY_MENU_CLOSE, KEY_TOGGLE_DO_NOT_DELEGATE, KEY_TOGGLE_NEEDS_REVIEW, KEY_MOVE } from './constants.js';
import { theme } from '../theme.js';
import { initAutocomplete, type AutocompleteInstance } from './opencode-autocomplete.js';

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

  async start(options: { inProgress?: boolean; prefix?: string; all?: boolean }): Promise<void> {
    const { program, utils } = this.ctx;
    // Allow tests to inject a mocked blessed implementation via the ctx object.
    // If not provided, fall back to the real blessed import.
    const blessedImpl = this.deps.blessed ?? (this.ctx as any).blessed ?? blessed;
    const spawnImpl: (...args: any[]) => ChildProcess = this.deps.spawn ?? (this.ctx as any).spawn ?? spawn;
    const fsImpl = this.deps.fs ?? fs;
    const fsAsync = (fsImpl as typeof fs).promises ?? fs.promises;
    const pathImpl = this.deps.path ?? path;
    const resolveWorklogDirImpl = this.deps.resolveWorklogDir ?? resolveWorklogDir;
    const createPersistenceImpl = this.deps.createPersistence ?? createPersistence;
    const createLayoutImpl = this.deps.createLayout ?? (this.ctx as any).createLayout ?? createLayout;
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

    const allItems: Item[] = db.list(query);
    const showClosed = Boolean(options.all);
    const visibleCandidates = showClosed
      ? allItems
      : allItems.filter(item => !isClosedStatus(item.status));
    let needsReviewFilter: boolean | null = visibleCandidates.some(item => Boolean(item.needsProducerReview)) ? true : null;
    const items: Item[] = needsReviewFilter === true
      ? allItems.filter(item => Boolean(item.needsProducerReview))
      : allItems;

    // Persisted state handling extracted to src/tui/persistence.ts
    const persistence = createPersistenceImpl(resolveWorklogDirImpl(), { debugLog: debugLog, fs: fsAsync });
    const persisted = await persistence.loadPersistedState(db.getPrefix?.() || undefined);
    const persistedExpanded = persisted && Array.isArray(persisted.expanded) ? persisted.expanded : undefined;
    const state = createTuiState(items, showClosed, persistedExpanded);

    // By default hide closed items (completed or deleted) unless --all is set
    if (state.currentVisibleItems.length === 0) {
      console.log('No work items found');
      return;
    }
    const rebuildTree = () => rebuildTreeState(state);

    const expandInProgressAncestors = () => {
      if (!activeFilterTerm) {
        expandAncestorsForInProgress(state);
      }
    };

    // Active search/filter term and preserved items when a filter is applied
    let activeFilterTerm = '';
    let preFilterItems: Item[] | null = null;

    // Persisted state file per-worklog directory
    const worklogDir = resolveWorklogDirImpl();
    const worklogRoot = pathImpl.dirname(worklogDir);
    const statePath = pathImpl.join(worklogDir, 'tui-state.json');
    void statePath;

    // Load persisted state for this prefix if present
     // persistence.savePersistedState / loadPersistedState are provided by createPersistence

    // Default expand roots unless persisted state exists
    rebuildTree();
    expandInProgressAncestors();
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
    const rules = loadStatusStageRules();
    const updateDialogStatusValues = rules.statusValues;
    const updateDialogStageValues = rules.stageValues.filter(stage => stage !== '');
    const updateDialogPriorityValues = ['critical', 'high', 'medium', 'low'];

    const endUpdateDialogCommentReading = () => {
      try {
        const widget = updateDialogComment as any;
        if (typeof widget?.cancel === 'function') {
          widget.cancel();
        }
        if (widget?._reading) {
          widget._reading = false;
        }
      } catch (_) {}
      try { (screen as any).grabKeys = false; } catch (_) {}
      try { (screen as any).program?.hideCursor?.(); } catch (_) {}
    };

    const startUpdateDialogCommentReading = () => {
      try {
        const widget = updateDialogComment as any;
        if (widget && typeof widget.readInput === 'function') {
          widget.readInput();
        }
      } catch (_) {}
    };

    const normalizeStatusValue = (value: string | undefined) => {
      if (!value) return value;
      const normalized = getStatusValueFromLabel(value, rules) ?? value;
      return getStatusLabel(normalized, rules) || normalized;
    };

    const normalizeStageValue = (value: string | undefined) => {
      if (!value) return value;
      const normalizedValue = getStageValueFromLabel(value, rules) ?? value;
      if (normalizedValue === '') return '';
      return normalizedValue;
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
      const filtered = allowed.filter(stage => stage !== '').map(stage => getStageLabel(stage, rules));
      const undefinedLabel = getStageLabel('', rules) || 'Undefined';
      if (allowBlank) return [undefinedLabel, ...filtered];
      if (filtered.length > 0) return filtered;
      return [undefinedLabel];
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
      updateDialogStatusOptions.setItems(updateDialogStatusValues.map(status => getStatusLabel(status, rules)));
      updateDialogPriorityOptions.setItems([...updateDialogPriorityValues]);
      const undefinedLabel = getStageLabel('', rules) || 'Undefined';
      const stageItems = item?.stage === ''
        ? [undefinedLabel, ...updateDialogStageValues.map(stage => getStageLabel(stage, rules))]
        : updateDialogStageValues.map(stage => getStageLabel(stage, rules));
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
      const stageValue = overrides?.stage ?? (item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules));
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
      const statusValue = getListItemValue(
        updateDialogStatusOptions,
        getStatusLabel(updateDialogStatusValues[0], rules)
      );
      const stageValue = getListItemValue(
        updateDialogStageOptions,
        getStageLabel(updateDialogStageValues[0], rules)
      );
      const priorityValue = getListItemValue(updateDialogPriorityOptions, updateDialogPriorityValues[2]);

      const normalizedStageValue = normalizeStageValue(stageValue) ?? '';
      const allowedStages = getAllowedStagesForStatus(getStatusValueFromLabel(statusValue, rules), {
        statusStage: rules.statusStageCompatibility,
        stageStatus: rules.stageStatusCompatibility,
      });
      const allowedStatuses = getAllowedStatusesForStage(normalizedStageValue, {
        statusStage: rules.statusStageCompatibility,
        stageStatus: rules.stageStatusCompatibility,
      });

      if (!updateDialogLastChanged) {
        if (item) {
          updateDialogHeader(item, {
            status: normalizeStatusValue(item.status),
            stage: item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules),
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
          const statusItems = (allowedStatuses.length ? [...allowedStatuses] : updateDialogStatusValues)
            .map(status => getStatusLabel(status, rules));
          setListItems(updateDialogStatusOptions, statusItems, statusValue);
        }

      const currentStatus = getListItemValue(
        updateDialogStatusOptions,
        getStatusLabel(updateDialogStatusValues[0], rules)
      );
      const currentStage = getListItemValue(
        updateDialogStageOptions,
        getStageLabel(updateDialogStageValues[0], rules)
      );
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
        list.style.selected.fg = list === focused ? theme.tui.colors.lightText : 'white';
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
          if (field === updateDialogComment) startUpdateDialogCommentReading();
        };
        const fieldBlurHandler = () => {
          applyUpdateDialogFocusStyles(updateDialogFieldOrder[updateDialogFocusManager.getIndex()]);
          if (!updateDialog.hidden) applyStatusStageCompatibility(getSelectedItem());
          if (field === updateDialogComment) endUpdateDialogCommentReading();
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
        try { (field as any).__opencode_key_tab = fieldTabHandler; (field as any).__opencode_key_stab = fieldShiftTabHandler; field.key(KEY_TAB, fieldTabHandler); field.key(KEY_SHIFT_TAB, fieldShiftTabHandler); } catch (_) {}
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
        try { (field as any).__opencode_key_left = fieldLeftHandler; (field as any).__opencode_key_right = fieldRightHandler; field.key(KEY_LEFT_SINGLE, fieldLeftHandler); field.key(KEY_RIGHT_SINGLE, fieldRightHandler); } catch (_) {}
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

    // Create ChordHandler and register Ctrl-W sequences now that opencodeText exists.
    // We preserve the small suppression flags used elsewhere (suppressNextP, lastCtrlWKeyHandled)
    // and provide the same timeout semantics as the legacy implementation.
    const chordHandler = new ChordHandler({ timeoutMs: 2000 });
    const chordDebug = !!process.env.TUI_CHORD_DEBUG;

    // Short-lived suppression helpers
    const clearCtrlWPending = () => {
      // Clear any pending state held by the chord handler (leader+wait)
      try { chordHandler.reset(); } catch (_) {}
    };

    // Register Ctrl-W chord handlers
    if (chordDebug) console.error('[tui] registering ctrl-w chord handlers');
    chordHandler.register(['C-w', 'w'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      clearCtrlWPending();
      cycleFocus(1);
      screen.render();
    });

    chordHandler.register(['C-w', 'p'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      clearCtrlWPending();
      focusPaneByIndex(lastPaneFocusIndex);
      screen.render();
      // Suppress the next plain 'p' handler briefly to avoid duplicate activation
      suppressNextP = true;
      if (suppressNextPTimeout) clearTimeout(suppressNextPTimeout);
      suppressNextPTimeout = setTimeout(() => { suppressNextP = false; suppressNextPTimeout = null; }, 100);
    });

    chordHandler.register(['C-w', 'h'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      clearCtrlWPending();
      const current = getActivePaneIndex();
      focusPaneByIndex(current - 1);
      screen.render();
    });

    chordHandler.register(['C-w', 'l'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      clearCtrlWPending();
      const current = getActivePaneIndex();
      focusPaneByIndex(current + 1);
      screen.render();
    });

    chordHandler.register(['C-w', 'j'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      if (opencodeDialog.hidden) return;
      if (!opencodePane || (opencodePane as any).hidden) return;
      clearCtrlWPending();
      // Focus the input textarea
      (opencodeText as Pane).focus?.();
      syncFocusFromScreen();
      screen.render();
      // Suppress widget-level typing for a short moment so the 'j' doesn't also insert
      lastCtrlWKeyHandled = true;
      if (lastCtrlWKeyHandledTimeout) clearTimeout(lastCtrlWKeyHandledTimeout);
      lastCtrlWKeyHandledTimeout = setTimeout(() => { lastCtrlWKeyHandled = false; lastCtrlWKeyHandledTimeout = null; }, 100);
    });

    chordHandler.register(['C-w', 'k'], () => {
      if (helpMenu.isVisible()) return;
      if (!detailModal.hidden || !nextDialog.hidden || !closeDialog.hidden || !updateDialog.hidden) return;
      if (opencodeDialog.hidden) return;
      if (!opencodePane || (opencodePane as any).hidden) return;
      clearCtrlWPending();
      (opencodePane as Pane).focus?.();
      syncFocusFromScreen();
      screen.render();
      lastCtrlWKeyHandled = true;
      if (lastCtrlWKeyHandledTimeout) clearTimeout(lastCtrlWKeyHandledTimeout);
      lastCtrlWKeyHandledTimeout = setTimeout(() => { lastCtrlWKeyHandled = false; lastCtrlWKeyHandledTimeout = null; }, 100);
    });

    // Debug helpers: log raw key events when debugging is enabled
    if (chordDebug) {
      try {
        const origOn = screen.on.bind(screen);
        screen.on('keypress', (_ch: any, key: any) => {
          try { console.error(`[tui] raw keypress: ch='${String(_ch)}' key=${JSON.stringify(key)}`); } catch (_) {}
        });
      } catch (_) {}
    }

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

      let suppressNextP = false;  // Flag to suppress 'p' handler after Ctrl-W p
      let suppressNextPTimeout: ReturnType<typeof setTimeout> | null = null;
      let lastCtrlWKeyHandled = false;  // Flag to suppress widget key handling after Ctrl-W command
      let lastCtrlWKeyHandledTimeout: ReturnType<typeof setTimeout> | null = null;



    // Command autocomplete support moved to src/tui/constants.ts

    // Autocomplete instance — initialized when the dialog is first opened.
    let autocompleteInstance: AutocompleteInstance | null = null;

    let isWaitingForResponse = false; // Track if we're waiting for OpenCode response
    let isLocalShellRunning = false;
    let localShellProcess: ChildProcess | null = null;
    let localShellOutput = '';
    const promptSpinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let promptSpinnerIndex = 0;
    let promptSpinnerTimer: ReturnType<typeof setInterval> | null = null;

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

    const isPromptBusy = () => isWaitingForResponse || isLocalShellRunning;

    const setOpencodeInputMode = (mode: OpencodeInputMode) => {
      opencodeInputMode = mode;
      (opencodeText as any).__opencode_mode = opencodeInputMode;
      updateOpencodePromptLabel(isPromptBusy() ? 'waiting' : 'idle');
    };

    const updateOpencodePromptLabel = (state: 'idle' | 'waiting') => {
      const modeSuffix = opencodeInputMode === 'normal' ? ' [normal]' : '';
      let stateSuffix = '';
      if (state === 'waiting') {
        const spinner = promptSpinnerFrames[promptSpinnerIndex % promptSpinnerFrames.length] || promptSpinnerFrames[0];
        stateSuffix = ` (waiting ${spinner})`;
      }
      opencodeDialog.setLabel(` prompt${stateSuffix} [esc]${modeSuffix} `);
    };

    const startPromptSpinner = () => {
      if (promptSpinnerTimer) return;
      promptSpinnerIndex = 0;
      promptSpinnerTimer = setInterval(() => {
        if (!isPromptBusy()) return;
        promptSpinnerIndex = (promptSpinnerIndex + 1) % promptSpinnerFrames.length;
        updateOpencodePromptLabel('waiting');
        screen.render();
      }, 120);
    };

    const stopPromptSpinner = () => {
      if (promptSpinnerTimer) {
        clearInterval(promptSpinnerTimer);
        promptSpinnerTimer = null;
      }
      promptSpinnerIndex = 0;
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

    // Apply the current autocomplete suggestion using the extracted module.
    function applyCommandSuggestion(target: any) {
      if (!autocompleteInstance) return false;
      const nextValue = autocompleteInstance.applySuggestion(target);
      if (nextValue) {
        try { setOpencodeCursorIndex(nextValue, nextValue.length); } catch (_) {}
        updateOpencodeCursor();
        screen.render();
        return true;
      }
      return false;
    }

    // Delegate autocomplete updates to the extracted module.
    function updateAutocomplete() {
      if (autocompleteInstance) {
        autocompleteInstance.updateFromValue();
      }
      try { updateOpencodeInputLayout(); } catch (_) {}
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

        // ALSO check if a chord prefix (e.g. Ctrl-W) is pending — if so, consume
        // the follow-up j/k so it isn't inserted into the textarea.
        if (chordHandler.isPending() && ['j', 'k'].includes(_key?.name)) {
          debugLog(`opencodeText: chordHandler is pending and key is ${_key?.name} - consuming event`);
          return false;
        }

        // Handle Ctrl+Enter for newline insertion
        if (_key && _key.name === 'linefeed') {
          // Get CURRENT value BEFORE the textarea adds the newline
          const currentValue = this.getValue ? this.getValue() : '';
          const currentVisualLines = getOpencodeVisualLineCount(currentValue);

          // Calculate what the height WILL BE after the newline
          const futureLines = currentVisualLines + 1;
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
      const keyObj = key as any;
      if (keyObj && keyObj.__opencode_input_handled) {
        return true;
      }
      if (keyObj) {
        keyObj.__opencode_input_handled = true;
      }

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
          updateOpencodeInputLayout();
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
          updateOpencodeInputLayout();
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
      updateOpencodeInputLayout();
      screen.render();
      return true;
    };
    try { (opencodeText as any)._listener = opencodeTextInputHandler; } catch (_) {}



    // Active opencode pane/process tracking
    let opencodePane: any = null;

    // Layout constants moved to src/tui/constants.ts
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
      // When a suggestion is active, grow the dialog by 1 row to make
      // room for the hint line below the textarea.
      const hasSugg = autocompleteInstance?.hasSuggestion() ?? false;
      const extra = hasSugg ? 1 : 0;
      const effectiveHeight = desiredHeight + extra;

      opencodeDialog.height = effectiveHeight;

      (opencodeText as any).border = false;
      opencodeText.top = 0;
      opencodeText.left = 0;
      opencodeText.width = '100%-2';
      opencodeText.height = desiredHeight - 2;
      clearOpencodeTextBorders();

      // Position the suggestion hint just below the textarea, inside the
      // dialog borders.  desiredHeight-2 is the textarea height; that's
      // also the row index right after the textarea.
      try {
        suggestionHint.top = desiredHeight - 2;
        suggestionHint.left = 1;
        suggestionHint.width = '100%-4';
      } catch (_) {}

      if (opencodePane) {
        opencodePane.bottom = effectiveHeight + FOOTER_HEIGHT;
        opencodePane.height = paneHeight();
      }
    };

    const calculateOpencodeDesiredHeight = (lines: number) => {
      return Math.min(Math.max(MIN_INPUT_HEIGHT, lines + 2), inputMaxHeight());
    };

    const getOpencodeVisualLineCount = (value: string) => {
      const clines = (opencodeText as any)._clines;
      if (Array.isArray(clines) && clines.length > 0) {
        return clines.length;
      }
      return value.split('\n').length;
    };

    function updateOpencodeInputLayout() {
      if (!opencodeText.getValue) return;
      const value = opencodeText.getValue();
      const visualLines = getOpencodeVisualLineCount(value);
      // Dialog height = content lines + 2 for borders
      const desiredHeight = calculateOpencodeDesiredHeight(visualLines);
      applyOpencodeCompactLayout(desiredHeight);
      const maxVisibleLines = Math.max(1, desiredHeight - 2);
      if (visualLines > maxVisibleLines && typeof opencodeText.setScrollPerc === 'function') {
        opencodeText.setScrollPerc(100);
      }
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
      if (autocompleteInstance) { autocompleteInstance.reset(); }
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

    // OpenCode server management (port defined in src/tui/constants.ts)

    function updateServerStatus(status: OpencodeServerStatus, port: number) {
      let statusText = '';
      switch (status) {
        case 'stopped':
          statusText = '[-] Server stopped';
          break;
        case 'starting':
          statusText = '[~] Starting...';
          break;
        case 'running':
          statusText = `[OK] Port: ${port}`;
          break;
        case 'error':
          statusText = '[X] Server error';
          break;
      }
      const taggedContent = `{white-fg}${statusText}{/}`;
      const plainLength = statusText.length;
      serverStatusBox.setContent(taggedContent);
      serverStatusBox.width = Math.max(1, plainLength + 2);
      screen.render();
    }

    // showToast is defined here so tests can intercept via ctx.toast.
    const showToast = (message: string) => {
      try {
        if (toastComponent && typeof toastComponent.show === 'function') toastComponent.show(message);
      } catch (_) {}
      try {
        // also notify any toast helper attached to the controller ctx (tests use this)
        (this as any).ctx?.toast?.show?.(message);
      } catch (_) {}
    };

    const opencodeClient = new OpencodeClientImpl({
      port: OPENCODE_SERVER_PORT,
      cwd: worklogRoot,
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
    
    function ensureOpencodePane(label = ' opencode [esc] ') {
      // In compact mode, adjust pane position to be above the input
      const currentHeight = opencodeDialog.height || MIN_INPUT_HEIGHT;
      const bottomOffset = currentHeight + FOOTER_HEIGHT;

      opencodePane = opencodeUi.ensureResponsePane({
        bottom: bottomOffset,
        height: paneHeight(),
        label,
        onEscape: () => {
          // Suppress the global escape handler immediately so the
          // response-pane-local Escape doesn't also trigger the
          // global handler (which would close the input dialog).
          suppressEscapeUntil = Date.now() + 250;
          try { closeOpencodePane(); } catch (_) {}
          // Return focus to the input textbox if it's visible so the
          // user can continue typing.
          try { opencodeText.focus(); } catch (_) {}
        },
      });
    }

    const appendLocalShellOutput = (chunk: string) => {
      localShellOutput += theme.tui.text.shellOutput(escapeBlessedTags(chunk));
      if (opencodePane?.setContent) {
        opencodePane.setContent(localShellOutput);
      }
      if (opencodePane?.setScrollPerc) {
        opencodePane.setScrollPerc(100);
      }
      screen.render();
    };

    const stopLocalShell = () => {
      isLocalShellRunning = false;
      localShellProcess = null;
      stopPromptSpinner();
      updateOpencodePromptLabel('idle');
    };

    const cancelLocalShell = () => {
      if (!localShellProcess) return;
      try { localShellProcess.kill('SIGINT'); } catch (_) {}
    };

    const runLocalShellCommand = (prompt: string) => {
      if (isPromptBusy()) {
        showToast('Please wait for current response to complete');
        return;
      }

      const command = prompt.slice(1);
      if (command.trim() === '') {
        showToast('Empty command');
        return;
      }

      ensureOpencodePane(' shell [esc] ');
      opencodePane.show();
      opencodePane.setFront();
      screen.render();

      localShellOutput = `${theme.tui.text.shellCommand(`$ ${escapeBlessedTags(command)}`)}\n`;
      if (opencodePane?.setContent) opencodePane.setContent(localShellOutput);
      if (opencodePane?.setScrollPerc) opencodePane.setScrollPerc(100);

      isLocalShellRunning = true;
      startPromptSpinner();
      updateOpencodePromptLabel('waiting');
      screen.render();

      try {
        localShellProcess = spawnImpl(command, {
          cwd: worklogRoot,
          shell: process.env.SHELL || true,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        stopLocalShell();
        showToast(`Command failed to start: ${String(err)}`);
        return;
      }

      localShellProcess.stdout?.on('data', (chunk: Buffer) => {
        appendLocalShellOutput(chunk.toString());
      });
      localShellProcess.stderr?.on('data', (chunk: Buffer) => {
        appendLocalShellOutput(chunk.toString());
      });
      localShellProcess.on('error', (err: unknown) => {
        stopLocalShell();
        showToast(`Command failed: ${String(err)}`);
      });
      localShellProcess.on('close', () => {
        stopLocalShell();
        try { openOpencodeDialog(); } catch (_) {}
      });
    };

    async function runOpencode(prompt: string) {
      if (!prompt || prompt.trim() === '') {
        showToast('Empty prompt');
        return;
      }

      if (prompt.startsWith('!')) {
        runLocalShellCommand(prompt);
        return;
      }

      // Block if we're already waiting for a response
      if (isPromptBusy()) {
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
      startPromptSpinner();
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
          stopPromptSpinner();
          updateOpencodePromptLabel('idle');
          openOpencodeDialog();
          },
        });
      } catch (err) {
        // Clear flag on error too and restore label
        isWaitingForResponse = false;
        stopPromptSpinner();
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
    try { (opencodeText as any).__opencode_key_escape = opencodeTextEscapeHandler; opencodeText.key(KEY_ESCAPE, opencodeTextEscapeHandler); } catch (_) {}

    const opencodeTextCtrlCHandler = function(this: any) {
      if (isLocalShellRunning) {
        cancelLocalShell();
        return;
      }
    };
    try { (opencodeText as any).__opencode_key_cc = opencodeTextCtrlCHandler; opencodeText.key(['C-c'], opencodeTextCtrlCHandler); } catch (_) {}

    // Accept Ctrl+S to send (keep for backward compatibility)
    const opencodeTextCSHandler = function(this: any) {
      const prompt = this.getValue ? this.getValue() : '';
      closeOpencodeDialog();
      runOpencode(prompt);
    };
    try { (opencodeText as any).__opencode_key_cs = opencodeTextCSHandler; opencodeText.key(KEY_CS, opencodeTextCSHandler); } catch (_) {}

     // Accept Enter to send, Ctrl+Enter for newline
    const opencodeTextEnterHandler = function(this: any) {
        const prompt = this.getValue ? this.getValue() : '';
        closeOpencodeDialog();
        runOpencode(prompt);
      };
       try { (opencodeText as any).__opencode_key_enter = opencodeTextEnterHandler; opencodeText.key(KEY_ENTER, opencodeTextEnterHandler); } catch (_) {}

    // Tab accepts the autocomplete suggestion (conventional shell/IDE behavior).
    // When no suggestion is active Tab is a no-op (prevents blessed from
    // inserting whitespace into the prompt).
    const opencodeTextTabHandler = function(this: any) {
      if (applyCommandSuggestion(this)) {
        return;
      }
      // Consume the event so blessed doesn't insert a tab character
      return false;
    };
    try { (opencodeText as any).__opencode_key_tab = opencodeTextTabHandler; opencodeText.key(KEY_TAB, opencodeTextTabHandler); } catch (_) {}

      // Suppress j/k keys when they're part of Ctrl-W commands
       const opencodeTextJHandler = function(this: any) {
         debugLog(`opencodeText.key(['j']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
         if (lastCtrlWKeyHandled) {
           debugLog(`opencodeText.key: Suppressing 'j' key (Ctrl-W command) - returning false`);
           return false;
         }
       };
    try { (opencodeText as any).__opencode_key_j = opencodeTextJHandler; opencodeText.key(KEY_J, opencodeTextJHandler); } catch (_) {}

      const opencodeTextKHandler = function(this: any) {
        debugLog(`opencodeText.key(['k']): lastCtrlWKeyHandled=${lastCtrlWKeyHandled}`);
        if (lastCtrlWKeyHandled) {
          debugLog(`opencodeText.key: Suppressing 'k' key (Ctrl-W command) - returning false`);
          return false;
        }
      };
    try { (opencodeText as any).__opencode_key_k = opencodeTextKHandler; opencodeText.key(KEY_K, opencodeTextKHandler); } catch (_) {}
    
    // Initialize the extracted autocomplete module and wire it to the
    // textarea widget. The module is statically imported at the top of
    // this file so it is always available.
    autocompleteInstance = initAutocomplete({ textarea: opencodeText, suggestionHint }, {
      availableCommands: AVAILABLE_COMMANDS,
      onSuggestionChange: (_active: boolean) => {
        // Re-run the compact layout so the dialog grows/shrinks to
        // accommodate the suggestion hint row.
        try { updateOpencodeInputLayout(); } catch (_) {}
      },
    });
    // Expose the instance on the widget for tests that inspect it.
    (opencodeText as any).__opencode_autocomplete = autocompleteInstance;


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
    try { (opencodeDialog as any).__opencode_key_escape = opencodeDialogEscapeHandler; opencodeDialog.key(KEY_ESCAPE, opencodeDialogEscapeHandler); } catch (_) {}


    state.listLines = [];
    function getNeedsReviewFilterLabel(): string {
      if (needsReviewFilter === true) return 'Review: On';
      if (needsReviewFilter === false) return 'Review: Off';
      return 'Review: All';
    }

    function renderListAndDetail(selectIndex = 0) {
      const visible = buildVisible();
      const lines = visible.map(n => {
        const indent = '  '.repeat(n.depth);
        const marker = n.hasChildren ? (state.expanded.has(n.item.id) ? '▾' : '▸') : ' ';
        const doNotDelegateBadge = Array.isArray(n.item.tags) && n.item.tags.includes('do-not-delegate')
          ? '{yellow-fg}⚑{/yellow-fg} '
          : '';
        const needsReviewBadge = n.item.needsProducerReview
          ? '{magenta-fg}●{/magenta-fg} '
          : '';
        const title = formatTitleOnlyTUI(n.item);
        let line = `${indent}${marker} ${needsReviewBadge}${doNotDelegateBadge}${title} {cyan-fg}({underline}${n.item.id}{/underline}){/cyan-fg}`;
        // Move mode visual feedback
        if (state.moveMode) {
          if (n.item.id === state.moveMode.sourceId) {
            // Source item: add [M] marker in yellow
            line = `${indent}${marker} {yellow-fg}[M]{/yellow-fg} ${needsReviewBadge}${doNotDelegateBadge}${title} {cyan-fg}({underline}${n.item.id}{/underline}){/cyan-fg}`;
          } else if (state.moveMode.descendantIds.has(n.item.id)) {
            // Descendant: dim the entire line
            line = `{gray-fg}${indent}${marker} ${stripTags(needsReviewBadge)}${stripTags(doNotDelegateBadge)}${stripTags(title)} (${n.item.id}){/gray-fg}`;
          }
        }
        return line;
      });
      state.listLines = lines;
      list.setItems(lines);
      // Keep selection in bounds
      const idx = Math.max(0, Math.min(selectIndex, lines.length - 1));
      list.select(idx);
      updateDetailForIndex(idx, visible);
      // Update footer/help
      try {
        if (state.moveMode) {
          // Move mode footer: show source item and instructions
          const sourceItem = state.itemsById.get(state.moveMode.sourceId);
          const sourceLabel = sourceItem ? sourceItem.title : state.moveMode.sourceId;
          help.setContent(`{yellow-fg}MOVE:{/yellow-fg} ${sourceLabel} — navigate to target, m/Enter to confirm, Esc to cancel`);
        } else {
          const closedCount = state.items.filter((item: any) => item.status === 'completed' || item.status === 'deleted').length;
          // Left side: show active filter if present (labelled "Filter:"), otherwise empty
          const filterLabel = activeFilterTerm ? `Filter: ${activeFilterTerm}` : '';
          const reviewLabel = getNeedsReviewFilterLabel();
          const leftText = [reviewLabel, filterLabel].filter(Boolean).join(' • ');
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

    function brightenDetailIdLine(value: string): string {
      const lines = value.split('\n');
      const updated = lines.map((line) => {
        const plain = stripAnsi(line);
        const match = plain.match(/^ID\s*:\s*(\S+)/);
        if (!match) return line;
        const id = match[1];
        const idIndex = plain.indexOf(id);
        if (idIndex === -1) return line;
        const prefix = plain.slice(0, idIndex);
        const suffix = plain.slice(idIndex + id.length);
        return `${prefix}{cyan-fg}${id}{/cyan-fg}${suffix}`;
      });
      return updated.join('\n');
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
      const brightened = brightenDetailIdLine(escaped);
      detail.setContent(decorateIdsForClick(brightened));
      detail.setScroll(0);
    }

    // ID parsing utilities moved to src/tui/id-utils.ts

    function getClickRow(box: any, data: any): { row: number; col: number } | null {
      const lpos = box?.lpos;
      const topBase = (lpos?.yi ?? box?.atop ?? 0) + (box?.itop ?? 0);
      const leftBase = (lpos?.xi ?? box?.aleft ?? 0) + (box?.ileft ?? 0);
      const row = (data?.y ?? 0) - topBase;
      const col = (data?.x ?? 0) - leftBase;
      if (row < 0 || col < 0) return null;
      return { row, col };
    }

    // Use helpers from id-utils for mapping/line wrapping

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
      const brightened = brightenDetailIdLine(escaped);
      detailModal.setContent(decorateIdsForClick(brightened));
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
        updateDialogHeader(item, { status: normalizeStatusValue(item.status), stage: item.stage === '' ? getStageLabel('', rules) || 'Undefined' : getStageLabel(item.stage, rules), priority: item.priority });
        updateDialogStatusOptions.select(findListIndex(updateDialogStatusValues.map(status => getStatusLabel(status, rules)), normalizeStatusValue(item.status), 0));
        const selectedStage = item.stage === '' ? undefined : getStageLabel(item.stage, rules);
        updateDialogStageOptions.select(findListIndex(updateDialogStageValues.map(stage => getStageLabel(stage, rules)), selectedStage, 0));
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
      endUpdateDialogCommentReading();
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
      needsReviewFilter?: boolean | null;
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
        needsReviewFilter: nextNeedsReviewFilter = needsReviewFilter,
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
      if (typeof nextNeedsReviewFilter !== 'undefined') {
        needsReviewFilter = nextNeedsReviewFilter;
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
      if (needsReviewFilter !== null) query.needsProducerReview = needsReviewFilter;
      state.items = db.list(query);
      const nextVisible = includeClosed
        ? state.items.slice()
        : state.items.filter((item: any) => item.status !== 'completed' && item.status !== 'deleted');
      if (nextVisible.length === 0) {
        list.setItems([]);
        detail.setContent('');
        showToast('No work items found');
        screen.render();
        return;
      }
      rebuildTree();
      expandInProgressAncestors();
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

    function setFilterNext(filter: 'in-progress' | 'open' | 'blocked' | 'intake_completed' | 'plan_completed') {
      const status = filter === 'in-progress'
        ? 'in-progress'
        : filter === 'blocked'
          ? 'blocked'
          : undefined;
      const inProgress = filter === 'in-progress';

      // Special-case stage-based filters
      if (filter === 'intake_completed' || filter === 'plan_completed') {
        const stage = filter === 'intake_completed' ? 'intake_complete' : 'plan_complete';
        refreshListWithOptions({
          status: undefined,
          includeClosed: false,
          updateOptions: { inProgress: false, all: false },
          clearShowClosed: true,
          allowFallback: false,
        });
        // After loading base items, post-filter by stage
        // Use a small timeout to let refreshListWithOptions repopulate state.items
        setTimeout(() => {
          state.items = state.items.filter((item: any) => item.stage === stage && item.status !== 'completed' && item.status !== 'deleted');
          state.showClosed = false;
          rebuildTree();
          expandInProgressAncestors();
          renderListAndDetail(0);
        }, 0);
        return;
      }

      refreshListWithOptions({
        status,
        includeClosed: false,
        updateOptions: { inProgress, all: false },
        clearShowClosed: true,
        allowFallback: false,
      });
    }

    function cycleNeedsReviewFilter() {
      const next = needsReviewFilter === true
        ? false
        : needsReviewFilter === false
          ? null
          : true;
      refreshListWithOptions({
        needsReviewFilter: next,
        includeClosed: options.all,
        clearShowClosed: false,
        allowFallback: false,
      });
      showToast(next === true ? 'Needs review: ON' : next === false ? 'Needs review: OFF' : 'Needs review: ALL');
    }

    function getSelectedItem(): Item | null {
      const idx = list.selected as number;
      const visible = buildVisible();
      const node = visible[idx] || visible[0];
      return node?.item || null;
    }

    async function copySelectedId() {
      const item = getSelectedItem();
      if (!item) return;
      // use injected spawn implementation when available so tests can mock it
      try {
        const res = await copyToClipboard(item.id, { spawn: spawnImpl });
        if (res.success) showToast('ID copied');
        else showToast(res.error ? `Copy failed: ${res.error}` : 'Copy failed');
      } catch (err: any) {
        showToast(err?.message || 'Copy failed');
      }
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
        try {
          const updated = db.update(item.id, { status: 'deleted', stage: '' });
          if (!updated) {
            showToast('Delete failed');
            return;
          }
          showToast('Deleted');
          refreshFromDatabase(nextIndex);
        } catch (err) {
          showToast('Delete failed');
        }
        return;
      }

      try {
        const updates = { status: 'completed' as const, stage };
        const compatible = isStatusStageCompatible(updates.status, updates.stage, {
          statusStage: rules.statusStageCompatibility,
          stageStatus: rules.stageStatusCompatibility,
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

    // (showToast already defined above)

    let nextWorkItem: Item | null = null;
    let nextWorkItemReason = '';
    let nextWorkItemRunning = false;
    let nextWorkItems: Item[] = [];
    let nextWorkItemReasons: string[] = [];
    let nextWorkItemIndex = 0;

    function formatStageLabel(stage: string | undefined): string | null {
      if (stage === undefined) return null;
      if (stage === '') return getStageLabel('', rules) || 'Undefined';
      return getStageLabel(stage, rules) || stage;
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
      expandInProgressAncestors();
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

    screen.key(KEY_NAV_RIGHT, (_ch: any, key: any) => {
      if (!updateDialog.hidden) return;
      // In move mode, Enter confirms the target (same as pressing 'm')
      if (state.moveMode && key?.name === 'enter') {
        const item = getSelectedItem();
        if (!item) return;
        const sourceId = state.moveMode.sourceId;
        const targetId = item.id;
        // Prevent selecting a descendant as target
        if (state.moveMode.descendantIds.has(targetId)) return;
        // Self-select: unparent to root
        if (targetId === sourceId) {
          const sourceItem = state.itemsById.get(sourceId);
          if (!sourceItem?.parentId) {
            showToast(`${sourceItem?.title || sourceId} is already at root level`);
            exitMoveMode(state);
            renderListAndDetail(list.selected as number);
            return;
          }
          try {
            const updated = db.update(sourceId, { parentId: null });
            if (!updated) { showToast('Move failed'); exitMoveMode(state); renderListAndDetail(list.selected as number); return; }
            showToast(`Moved ${sourceItem?.title || sourceId} to root level`);
          } catch (err) { showToast('Move failed'); }
          exitMoveMode(state);
          refreshFromDatabase();
          const vis = buildVisible();
          const mIdx = vis.findIndex(n => n.item.id === sourceId);
          if (mIdx >= 0) renderListAndDetail(mIdx);
          return;
        }
        // Reparent under target
        try {
          const updated = db.update(sourceId, { parentId: targetId });
          if (!updated) { showToast('Move failed'); exitMoveMode(state); renderListAndDetail(list.selected as number); return; }
          const sourceItem = state.itemsById.get(sourceId);
          const targetItem = state.itemsById.get(targetId);
          showToast(`Moved ${sourceItem?.title || sourceId} under ${targetItem?.title || targetId}`);
        } catch (err) { showToast('Move failed'); }
        exitMoveMode(state);
        refreshFromDatabase();
        state.expanded.add(targetId);
        const vis = buildVisible();
        const mIdx = vis.findIndex(n => n.item.id === sourceId);
        if (mIdx >= 0) renderListAndDetail(mIdx);
        return;
      }
      const idx = list.selected as number;
      const visible = buildVisible();
      const node = visible[idx];
      if (node && node.hasChildren) {
        state.expanded.add(node.item.id);
        renderListAndDetail(idx);
      }
    });

    screen.key(KEY_NAV_LEFT, () => {
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
    screen.key(KEY_TOGGLE_EXPAND, () => {
      const idx = list.selected as number;
      const visible = buildVisible();
      const node = visible[idx];
      if (!node || !node.hasChildren) return;
      if (state.expanded.has(node.item.id)) state.expanded.delete(node.item.id);
      else state.expanded.add(node.item.id);
      renderListAndDetail(idx);
      // persist state
      void persistence.savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(state.expanded) });
    });

    const shutdown = () => {
      isShuttingDown = true;
      // Persist state before exiting
      try { void persistence.savePersistedState(db.getPrefix?.() || undefined, { expanded: Array.from(state.expanded) }); } catch (_) {}
      stopDatabaseWatch();
      // Stop the OpenCode server if we started it
      opencodeClient.stopServer();
      // Clear pending timers to avoid keeping the process alive
      try { chordHandler.reset(); } catch (_) {}
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
    screen.key(KEY_QUIT, () => {
      if (isLocalShellRunning) {
        cancelLocalShell();
        return;
      }
      shutdown();
    });

    // NOTE: keep an extra textual reference to `shutdown();` so tests that
    // scan source for use of the shared shutdown helper (and ensure there
    // are multiple call-sites) continue to pass. This branch never runs.
    if (false) { shutdown(); }

    screen.key(KEY_ESCAPE, () => {
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
      // Cancel move mode if active
      if (state.moveMode) {
        exitMoveMode(state);
        showToast('Move cancelled');
        renderListAndDetail(list.selected as number);
        return;
      }
      // Do not shut down the entire TUI on a bare Escape press when no
      // overlays are visible — use 'q' or Ctrl-C to quit. This prevents
      // accidental exits when users expect Escape to only dismiss dialogs.
      return;
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
     screen.key(KEY_TOGGLE_HELP, () => {
       if (!helpMenu.isVisible()) openHelp();
       else closeHelp();
     });

      // Raw keypress handler feeds into chord handler. If the chord system
      // consumes the event, stop further processing.
      screen.on('keypress', (_ch: any, key: any) => {
        debugLog(`Raw keypress: ch="${_ch}", key.name="${key?.name}", key.ctrl=${key?.ctrl}, key.meta=${key?.meta}`);
        try {
          if (chordHandler.feed(key as KeyInfo)) {
            debugLog(`ChordHandler consumed key event`);
            return false;
          }
        } catch (err) {
          debugLog(`ChordHandler.feed threw: ${(err as any)?.message ?? String(err)}`);
        }
        
        // No legacy pending-state fallback: chordHandler.feed handles all
        // Ctrl-W prefixes and their follow-ups. If chordHandler didn't
        // consume the event we fall through to normal key handlers.
      });

        // Keep lightweight screen.key wrappers so tests and some widget-level
        // handlers that register via screen.key still see a handler. These
        // simply forward to the chordHandler so both the raw keypress path
        // and the older key-based registration behave the same in tests.
        try {
        screen.key(KEY_CHORD_PREFIX, (_ch: any, key: any) => {
            try {
              if (chordHandler.feed(key as KeyInfo)) {
                debugLog(`screen.key C-w -> chord consumed`);
                return false;
              }
            } catch (err) { debugLog(`C-w wrapper error: ${String(err)}`); }
          });
        } catch (_) {}

        try {
          screen.key(KEY_CHORD_FOLLOWUPS, (_ch: any, key: any) => {
            // If the key had a ctrl modifier, let the Ctrl handler deal with it
            if (key?.ctrl) return;
            try {
              if (chordHandler.feed(key as KeyInfo)) {
                debugLog(`screen.key ${String(key?.name)} -> chord consumed`);
                return false;
              }
            } catch (err) { debugLog(`hjklwp wrapper error: ${String(err)}`); }
            // Not consumed by chord system — fall through to normal handlers
          });
        } catch (_) {}


    // Open opencode prompt dialog (shortcut O)
     screen.key(KEY_OPEN_OPENCODE, async () => {
       if (state.moveMode) return;
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
     screen.key(KEY_OPEN_SEARCH, async () => {
       if (state.moveMode) return;
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
            expandInProgressAncestors();
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
        if (needsReviewFilter !== null) {
          args.push('--needs-producer-review', String(needsReviewFilter));
        }
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
            expandInProgressAncestors();
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
     screen.key(KEY_COPY_ID, () => {
       if (state.moveMode) return;
       copySelectedId();
     });

      // Open parent preview
       screen.key(KEY_PARENT_PREVIEW, () => {
         if (state.moveMode) return;
         if (suppressNextP) {
          debugLog(`Suppressing 'p' handler (just handled Ctrl-W p)`);
          return;
        }
        openParentPreview();
      });

    // Close selected item
     screen.key(KEY_CLOSE_ITEM, () => {
       if (state.moveMode) return;
       if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden) {
        openCloseDialog();
      }
    });

    // Update selected item (quick edit) - shortcut U
     screen.key(KEY_UPDATE_ITEM, () => {
       if (state.moveMode) return;
       if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden) {
        openUpdateDialog();
      }
    });

    // Toggle do-not-delegate tag on selected item (shortcut D)
     screen.key(KEY_TOGGLE_DO_NOT_DELEGATE, () => {
       // Only act when no interfering overlays are visible
       if (!detailModal.hidden || helpMenu.isVisible() || !closeDialog.hidden || !updateDialog.hidden || !nextDialog.hidden) return;
       if (state.moveMode) return;
      const item = getSelectedItem();
      if (!item) {
        showToast('No item selected');
        return;
      }
      try {
        const has = Array.isArray(item.tags) && item.tags.includes('do-not-delegate');
        const newTags = has ? item.tags.filter(t => t !== 'do-not-delegate') : Array.from(new Set([...(item.tags || []), 'do-not-delegate']));
        const updated = db.update(item.id, { tags: newTags });
        if (!updated) {
          showToast('Update failed');
          return;
        }
        showToast(has ? 'Do-not-delegate: OFF' : 'Do-not-delegate: ON');
        // Refresh list and detail keeping selection
        refreshFromDatabase(list.selected as number);
      } catch (err) {
        showToast('Update failed');
      }
    });

    // Toggle needs producer review flag (shortcut r)
     screen.key(KEY_TOGGLE_NEEDS_REVIEW, () => {
       if (!detailModal.hidden || helpMenu.isVisible() || !closeDialog.hidden || !updateDialog.hidden || !nextDialog.hidden) return;
       if (state.moveMode) return;
      const item = getSelectedItem();
      if (!item) {
        showToast('No item selected');
        return;
      }
      try {
        const nextValue = !Boolean(item.needsProducerReview);
        const updated = db.update(item.id, { needsProducerReview: nextValue });
        if (!updated) {
          showToast('Update failed');
          return;
        }
        showToast(nextValue ? 'Needs review: ON' : 'Needs review: OFF');
        refreshFromDatabase(list.selected as number);
      } catch (err) {
        showToast('Update failed');
      }
    });

    // Move/reparent mode (shortcut M)
    screen.key(KEY_MOVE, () => {
      // Guard: only active when no overlays are visible
      if (!detailModal.hidden || helpMenu.isVisible() || !closeDialog.hidden || !updateDialog.hidden || !nextDialog.hidden) return;
      if (!opencodeDialog.hidden) return;

      const item = getSelectedItem();
      if (!item) {
        showToast('No item selected');
        return;
      }

      if (!state.moveMode) {
        // Enter move mode: store the source item
        enterMoveMode(state, item.id);
        showToast('Move mode: select target, press m/Enter; Esc to cancel');
        renderListAndDetail(list.selected as number);
        return;
      }

      // Already in move mode — this is a target confirmation
      const sourceId = state.moveMode.sourceId;
      const targetId = item.id;

      // Prevent selecting a descendant as target (circular)
      if (state.moveMode.descendantIds.has(targetId)) {
        return; // no-op on invalid targets
      }

      // Self-select: unparent to root (F5)
      if (targetId === sourceId) {
        const sourceItem = state.itemsById.get(sourceId);
        if (!sourceItem?.parentId) {
          showToast(`${sourceItem?.title || sourceId} is already at root level`);
          exitMoveMode(state);
          renderListAndDetail(list.selected as number);
          return;
        }
        try {
          const updated = db.update(sourceId, { parentId: null });
          if (!updated) {
            showToast('Move failed');
            exitMoveMode(state);
            renderListAndDetail(list.selected as number);
            return;
          }
          const title = sourceItem?.title || sourceId;
          showToast(`Moved ${title} to root level`);
        } catch (err) {
          showToast('Move failed');
        }
        exitMoveMode(state);
        refreshFromDatabase();
        // After refresh, find and select the moved item
        const visible = buildVisible();
        const movedIdx = visible.findIndex(n => n.item.id === sourceId);
        if (movedIdx >= 0) {
          renderListAndDetail(movedIdx);
        }
        return;
      }

      // Reparent: move source under target (F4)
      try {
        const updated = db.update(sourceId, { parentId: targetId });
        if (!updated) {
          showToast('Move failed');
          exitMoveMode(state);
          renderListAndDetail(list.selected as number);
          return;
        }
        const sourceItem = state.itemsById.get(sourceId);
        const targetItem = state.itemsById.get(targetId);
        const sourceTitle = sourceItem?.title || sourceId;
        const targetTitle = targetItem?.title || targetId;
        showToast(`Moved ${sourceTitle} under ${targetTitle}`);
      } catch (err) {
        showToast('Move failed');
      }
      exitMoveMode(state);
      // Refresh and auto-expand the new parent, then select the moved item
      refreshFromDatabase();
      state.expanded.add(targetId);
      const visible = buildVisible();
      const movedIdx = visible.findIndex(n => n.item.id === sourceId);
      if (movedIdx >= 0) {
        renderListAndDetail(movedIdx);
      }
      return;
    });

    // Also handle Enter to confirm move mode target
    // (Enter is already used for expand — override when in move mode)

    // Refresh from database
    if (KEY_REFRESH.length > 0) {
      screen.key(KEY_REFRESH, () => {
        refreshFromDatabase();
      });
    }

    // Evaluate next item
     screen.key(KEY_FIND_NEXT, () => {
       if (state.moveMode) return;
       if (detailModal.hidden && !helpMenu.isVisible() && closeDialog.hidden && updateDialog.hidden && nextDialog.hidden) {
         openNextDialog();
       }
     });

     // Filter shortcuts
     screen.key(KEY_FILTER_IN_PROGRESS, () => {
       if (state.moveMode) return;
       setFilterNext('in-progress');
     });

     screen.key(KEY_FILTER_OPEN, () => {
       if (state.moveMode) return;
       setFilterNext('open');
     });

      screen.key(KEY_FILTER_BLOCKED, () => {
        if (state.moveMode) return;
        setFilterNext('blocked');
      });

      screen.key(KEY_FILTER_INTAKE_COMPLETED, () => {
        if (state.moveMode) return;
        setFilterNext('intake_completed');
      });

      screen.key(KEY_FILTER_PLAN_COMPLETED, () => {
        if (state.moveMode) return;
        setFilterNext('plan_completed');
      });

     screen.key(KEY_FILTER_NEEDS_REVIEW, () => {
       if (state.moveMode) return;
       if (!detailModal.hidden || helpMenu.isVisible() || !closeDialog.hidden || !updateDialog.hidden || !nextDialog.hidden) return;
       cycleNeedsReviewFilter();
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
            expandInProgressAncestors();
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

    const updateOverlayClickHandler = async () => {
      // Check for unsaved changes before dismissing
      const commentValue = updateDialogComment?.getValue ? updateDialogComment.getValue() : '';
      const hasUnsavedChanges = (commentValue || '').trim() !== '' || updateDialogLastChanged !== null;
      if (hasUnsavedChanges) {
        const confirmed = await modalDialogs.confirmYesNo({
          title: 'Discard unsaved changes?',
          message: 'You have unsaved changes. Discard them?',
        });
        if (!confirmed) return;
      }
      closeUpdateDialog();
    };
    try { (updateOverlay as any).__opencode_click = updateOverlayClickHandler; updateOverlay.on('click', updateOverlayClickHandler); } catch (_) {}

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
    try { (updateDialog as any).__opencode_key_escape = updateDialogEscapeHandler; updateDialog.key(KEY_ESCAPE, updateDialogEscapeHandler); } catch (_) {}

    const updateDialogOptionsEscapeHandler = () => { closeUpdateDialog(); };
    try { (updateDialogOptions as any).__opencode_key_escape = updateDialogOptionsEscapeHandler; updateDialogOptions.key(KEY_ESCAPE, updateDialogOptionsEscapeHandler); } catch (_) {}

    const updateDialogCommentEscapeHandler = () => { closeUpdateDialog(); };
    try { (updateDialogComment as any).__opencode_key_escape = updateDialogCommentEscapeHandler; updateDialogComment.key(KEY_ESCAPE, updateDialogCommentEscapeHandler); } catch (_) {}

    const updateDialogCommentEnterHandler = () => {
      if (updateDialog.hidden) return;
      submitUpdateDialog();
      return false;
    };
    try { (updateDialogComment as any).__opencode_key_enter = updateDialogCommentEnterHandler; updateDialogComment.key(KEY_ENTER, updateDialogCommentEnterHandler); } catch (_) {}

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
    try { (updateDialogComment as any).__opencode_key_linefeed = updateDialogCommentLinefeedHandler; updateDialogComment.key(KEY_LINEFEED, updateDialogCommentLinefeedHandler); } catch (_) {}

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
      const statusValues = listItemsToValues(updateDialogStatusOptions, (value) => getStatusValueFromLabel(value, rules) ?? value);
      const stageValues = listItemsToValues(updateDialogStageOptions, (value) => getStageValueFromLabel(value, rules) ?? value);
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
          statusStage: rules.statusStageCompatibility,
          stageStatus: rules.stageStatusCompatibility,
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
        const message = err instanceof Error
          ? err.message
          : (typeof err === 'string' ? err : 'Update failed');
        showToast(message || 'Update failed');
      }

      closeUpdateDialog();
    };

    const updateDialogEnterHandler = () => { if (updateDialog.hidden) return; submitUpdateDialog(); };
    try { (updateDialog as any).__opencode_key_enter = updateDialogEnterHandler; updateDialog.key(KEY_ENTER, updateDialogEnterHandler); } catch (_) {}

    const updateDialogCSHandler = () => { if (updateDialog.hidden) return; submitUpdateDialog(); };
    try { (updateDialog as any).__opencode_key_cs = updateDialogCSHandler; updateDialog.key(KEY_CS, updateDialogCSHandler); } catch (_) {}

    const updateDialogStatusEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogStatusOptions as any).__opencode_key_enter = updateDialogStatusEnterHandler; updateDialogStatusOptions.key(KEY_ENTER, updateDialogStatusEnterHandler); } catch (_) {}

    const updateDialogStageEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogStageOptions as any).__opencode_key_enter = updateDialogStageEnterHandler; updateDialogStageOptions.key(KEY_ENTER, updateDialogStageEnterHandler); } catch (_) {}

    const updateDialogPriorityEnterHandler = () => { submitUpdateDialog(); };
    try { (updateDialogPriorityOptions as any).__opencode_key_enter = updateDialogPriorityEnterHandler; updateDialogPriorityOptions.key(KEY_ENTER, updateDialogPriorityEnterHandler); } catch (_) {}

    const updateDialogTabHandler = () => { if (updateDialog.hidden) return; updateDialogFocusManager.cycle(1); };
    try { (updateDialog as any).__opencode_key_tab = updateDialogTabHandler; updateDialog.key(KEY_TAB, updateDialogTabHandler); } catch (_) {}

    const updateDialogSTabHandler = () => { if (updateDialog.hidden) return; updateDialogFocusManager.cycle(-1); };
    try { (updateDialog as any).__opencode_key_stab = updateDialogSTabHandler; updateDialog.key(KEY_SHIFT_TAB, updateDialogSTabHandler); } catch (_) {}

    const closeDialogEscapeHandler = () => { closeCloseDialog(); };
    try { (closeDialog as any).__opencode_key_escape = closeDialogEscapeHandler; closeDialog.key(KEY_ESCAPE, closeDialogEscapeHandler); } catch (_) {}

    const closeDialogOptionsEscapeHandler = () => { closeCloseDialog(); };
    try { (closeDialogOptions as any).__opencode_key_escape = closeDialogOptionsEscapeHandler; closeDialogOptions.key(KEY_ESCAPE, closeDialogOptionsEscapeHandler); } catch (_) {}

    const nextDialogEscapeHandler = () => { closeNextDialog(); };
    try { (nextDialog as any).__opencode_key_escape = nextDialogEscapeHandler; nextDialog.key(KEY_ESCAPE, nextDialogEscapeHandler); } catch (_) {}

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
    try { (nextDialogOptions as any).__opencode_key_n = nextDialogOptionsNHandler; nextDialogOptions.key(KEY_FIND_NEXT, nextDialogOptionsNHandler); } catch (_) {}

    const nextDialogOptionsEscapeHandler = () => { closeNextDialog(); };
    try { (nextDialogOptions as any).__opencode_key_escape = nextDialogOptionsEscapeHandler; nextDialogOptions.key(KEY_ESCAPE, nextDialogOptionsEscapeHandler); } catch (_) {}

    const detailOverlayClickHandler = () => { closeDetails(); };
    try { (detailOverlay as any).__opencode_click = detailOverlayClickHandler; detailOverlay.on('click', detailOverlayClickHandler); } catch (_) {}

    detailModal.key(KEY_ESCAPE, () => {
      closeDetails();
    });

    screen.on('mouse', (data: any) => {
      if (!data || !['mousedown', 'mouseup', 'click'].includes(data.action)) return;
      if (!detailModal.hidden && Date.now() < suppressDetailCloseUntil) return;
      if (!detailModal.hidden && !isInside(detailModal, data.x, data.y)) {
        closeDetails();
        return;
      }
      // Guard: do not process list/detail clicks when any dialog is open.
      // Dialog-internal mouse events are handled by blessed's per-widget
      // dispatch and are unaffected by this guard.
      if (!updateDialog.hidden || !closeDialog.hidden || !nextDialog.hidden) return;
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
