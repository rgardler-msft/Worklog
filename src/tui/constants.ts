/**
 * Centralized TUI constants and command/shortcut definitions.
 *
 * Move magic values (command lists, keyboard shortcuts, numeric layout values)
 * here so they can be documented, localized, and changed in one place.
 */

export const AVAILABLE_COMMANDS: string[] = [
  '/help',
  '/clear',
  '/create',
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
  '/revert',
];

// Default shortcuts used by the help menu. Keep the shape stable so the
// HelpMenuComponent can simply render this structure.
export const DEFAULT_SHORTCUTS = [
  {
    category: 'Navigation',
    items: [
      { keys: 'Up/Down, j/k', description: 'Move selection' },
      { keys: 'PageUp/PageDown, Home/End', description: 'Jump' },
    ],
  },
  {
    category: 'Tree',
    items: [
      { keys: 'Right/Enter', description: 'Expand node' },
      { keys: 'Left', description: 'Collapse node / parent' },
      { keys: 'Space', description: 'Toggle expand/collapse' },
    ],
  },
  {
    category: 'Focus',
    items: [
      { keys: 'Ctrl+W, Ctrl+W', description: 'Cycle focus panes' },
      { keys: 'Ctrl+W, h/l', description: 'Focus list/details' },
      { keys: 'Ctrl+W, k/j', description: 'OpenCode response/input' },
      { keys: 'Ctrl+W, p', description: 'Previous pane' },
    ],
  },
  {
    category: 'Filters',
    items: [
      { keys: '/', description: 'Search/Filter' },
      { keys: 'I', description: 'Show in-progress only' },
      { keys: 'A', description: 'Show open items' },
      { keys: 'B', description: 'Show blocked only' },
      { keys: 'V', description: 'Needs review filter (cycle)' },
      { keys: 'T', description: 'Show intake_completed items' },
      { keys: 'P', description: 'Show plan_complete items' },
    ],
  },
  {
    category: 'Clipboard',
    items: [
      { keys: 'C', description: 'Copy selected item ID' },
    ],
  },
  {
    category: 'Preview',
    items: [
      { keys: 'P', description: 'Open parent in modal' },
    ],
  },
  {
    category: 'Actions',
    items: [
      { keys: 'O', description: 'Open OpenCode prompt' },
      { keys: 'N', description: 'Find next work item' },
      { keys: 'N (dialog)', description: 'Next recommendation' },
      { keys: 'X', description: 'Close selected item' },
      { keys: 'U', description: 'Update selected item' },
      { keys: 'M', description: 'Move/reparent item' },
      { keys: 'D', description: 'Toggle do-not-delegate' },
      { keys: 'r/R', description: 'Toggle needs review' },
    ],
  },
  {
    category: 'Help',
    items: [
      { keys: '?', description: 'Toggle this help' },
    ],
  },
  {
    category: 'Exit',
    items: [
      { keys: 'q, Esc, Ctrl-C', description: 'Quit (Ctrl-C in prompt cancels shell)' },
    ],
  },
];

// Key binding constants used by screen.key and for documentation.
// Keep these as arrays to remain compatible with blessed's API.
export const KEY_NAV_RIGHT = ['right', 'enter'];
export const KEY_NAV_LEFT = ['left'];
export const KEY_TOGGLE_EXPAND = ['space'];
export const KEY_QUIT = ['q', 'C-c'];
export const KEY_ESCAPE = ['escape'];
export const KEY_TOGGLE_HELP = ['?'];
export const KEY_CHORD_PREFIX = ['C-w'];
export const KEY_CHORD_FOLLOWUPS = ['h', 'j', 'k', 'l', 'w', 'p'];
export const KEY_OPEN_OPENCODE = ['o', 'O'];
export const KEY_OPEN_SEARCH = ['/'];

// Additional key constants for widget-level handlers and dialogs
export const KEY_TAB = ['tab', 'C-i'];
export const KEY_SHIFT_TAB = ['S-tab', 'C-S-i'];
export const KEY_LEFT_SINGLE = ['left'];
export const KEY_RIGHT_SINGLE = ['right'];
export const KEY_CS = ['C-s'];
export const KEY_ENTER = ['enter'];
export const KEY_LINEFEED = ['linefeed', 'C-j'];
export const KEY_J = ['j'];
export const KEY_K = ['k'];
export const KEY_COPY_ID = ['c', 'C'];
export const KEY_PARENT_PREVIEW = ['p', 'P'];
export const KEY_CLOSE_ITEM = ['x', 'X'];
export const KEY_UPDATE_ITEM = ['u', 'U'];
export const KEY_REFRESH: string[] = [];
export const KEY_FIND_NEXT = ['n', 'N'];
export const KEY_FILTER_IN_PROGRESS = ['i', 'I'];
export const KEY_FILTER_OPEN = ['a', 'A'];
export const KEY_FILTER_BLOCKED = ['b', 'B'];
export const KEY_FILTER_NEEDS_REVIEW = ['v', 'V'];
export const KEY_FILTER_INTAKE_COMPLETED = ['t', 'T'];
export const KEY_FILTER_PLAN_COMPLETED = ['p', 'P'];
export const KEY_TOGGLE_DO_NOT_DELEGATE = ['d', 'D'];
export const KEY_TOGGLE_NEEDS_REVIEW = ['r', 'R'];
export const KEY_MOVE = ['m', 'M'];

// Composite keys often used in help menu / close handlers
export const KEY_MENU_CLOSE = ['escape', 'q'];



// Layout / behavior constants used by the TUI. Centralizing these makes it
// easier to tweak layout across platforms.
export const MIN_INPUT_HEIGHT = 3; // Minimum height for input dialog (single line + borders)
export const MAX_INPUT_LINES = 7;  // Maximum visible lines of input text
export const FOOTER_HEIGHT = 1;    // Height reserved for the footer

// Port for the OpenCode server; if unset, let the server select its own port.
const parsedOpencodePort = Number.parseInt(process.env.OPENCODE_SERVER_PORT ?? '', 10);
export const OPENCODE_SERVER_PORT = Number.isFinite(parsedOpencodePort) ? parsedOpencodePort : 0;

export default {
  AVAILABLE_COMMANDS,
  DEFAULT_SHORTCUTS,
  MIN_INPUT_HEIGHT,
  MAX_INPUT_LINES,
  FOOTER_HEIGHT,
  OPENCODE_SERVER_PORT,
};
