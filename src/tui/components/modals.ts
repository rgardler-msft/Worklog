import blessed from 'blessed';
import { theme } from '../../theme.js';
import { KEY_ESCAPE, KEY_CS } from '../constants.js';
import type {
  BlessedBox,
  BlessedFactory,
  BlessedList,
  BlessedScreen,
  BlessedTextbox,
  BlessedText,
} from '../types.js';

export interface ModalDialogsOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class ModalDialogsComponent {
  private screen: BlessedScreen;
  private blessedImpl: BlessedFactory;
  private activeCleanup: (() => void) | null = null;

  constructor(options: ModalDialogsOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;
  }

  create(): this {
    return this;
  }

  show(): void {
    // Modals are shown individually.
  }

  hide(): void {
    // No-op; dialogs are transient.
  }

  focus(): void {
    // No single focus target.
  }

  destroy(): void {
    // No persistent elements.
  }

  forceCleanup(): void {
    try { this.activeCleanup?.(); } catch (_) {}
    this.activeCleanup = null;
    this.releaseGrabKeys();
  }

  async selectList(options: {
    title: string;
    message: string;
    items: string[];
    defaultIndex?: number;
    cancelIndex?: number;
    width?: string | number;
    height?: string | number;
  }): Promise<number> {
    return new Promise((resolve) => {
      const overlay = this.createOverlay();
      const dialog = this.blessedImpl.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: options.width || '60%',
        height: options.height || 10,
        label: ` ${options.title} `,
        border: { type: 'line' },
        tags: true,
        mouse: true,
        clickable: true,
      }) as BlessedBox;

      const text = this.blessedImpl.box({
        parent: dialog,
        top: 1,
        left: 2,
        width: '100%-4',
        height: 3,
        content: options.message,
        tags: true,
      }) as BlessedBox;
      void text;

      const list = this.blessedImpl.list({
        parent: dialog,
        top: 5,
        left: 2,
        width: '100%-4',
        height: Math.min(4, options.items.length),
        keys: true,
        mouse: true,
        items: options.items,
        style: { selected: { bg: 'blue' } },
      }) as BlessedList;

      const defaultIndex = options.defaultIndex ?? 0;
      const cancelIndex = options.cancelIndex ?? options.items.length - 1;
      list.select(defaultIndex);

      const cleanup = () => {
        this.destroyWidgets([list, dialog, overlay]);
      };

      list.on('select', (_el: any, idx: number) => {
        cleanup();
        resolve(idx);
      });

      list.on('select item', (_el: any, idx: number) => {
        cleanup();
        resolve(idx);
      });

      list.on('click', () => {
        const idx = (list as any).selected ?? 0;
        if (typeof (list as any).emit === 'function') {
          (list as any).emit('select item', null, idx);
          return;
        }
        cleanup();
        resolve(idx);
      });

      dialog.key(KEY_ESCAPE, () => {
        cleanup();
        resolve(cancelIndex);
      });

      overlay.on('click', () => {
        cleanup();
        resolve(cancelIndex);
      });

      overlay.setFront();
      dialog.setFront();
      list.focus();
      this.screen.render();
    });
  }

  async editTextarea(options: {
    title: string;
    initial: string;
    confirmLabel: string;
    cancelLabel: string;
    width?: string | number;
    height?: string | number;
  }): Promise<string> {
    return new Promise((resolve) => {
      let resolved = false;
      const overlay = this.createOverlay();
      const dialog = this.blessedImpl.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: options.width || '60%',
        height: options.height || 5,
        label: ` ${options.title} `,
        border: { type: 'line' },
        tags: true,
        mouse: true,
        clickable: true,
      }) as BlessedBox;

      // Single-line textbox: emits 'submit' on Enter (textarea would
      // swallow Enter to insert a newline).
      const textbox = this.blessedImpl.textbox({
        parent: dialog,
        top: 1,
        left: 1,
        width: '100%-2',
        height: 1,
        inputOnFocus: true,
        keys: true,
        mouse: true,
      }) as BlessedTextbox;

      try {
        if (typeof textbox.setValue === 'function') textbox.setValue(options.initial);
      } catch (_) {}

      const confirmBtn = this.blessedImpl.box({
        parent: dialog,
        bottom: 0,
        left: 1,
        height: 1,
        width: options.confirmLabel.length + 2,
        content: `[${options.confirmLabel}]`,
        mouse: true,
        clickable: true,
        style: { fg: 'green' },
      }) as BlessedBox;

      const cancelBtn = this.blessedImpl.box({
        parent: dialog,
        bottom: 0,
        left: options.confirmLabel.length + 4,
        height: 1,
        width: options.cancelLabel.length + 2,
        content: `[${options.cancelLabel}]`,
        mouse: true,
        clickable: true,
        style: { fg: 'yellow' },
      }) as BlessedBox;

      const cleanup = () => {
        this.endTextboxReading(textbox);
        this.destroyWidgets([confirmBtn, cancelBtn, textbox, dialog, overlay]);
        if (this.activeCleanup === cleanup) this.activeCleanup = null;
      };
      this.activeCleanup = cleanup;

      const safeResolve = (value: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      };

      const getValue = () => textbox.getValue ? textbox.getValue() : options.initial;

      // Submit: Enter, Ctrl-S, or click [Apply]
      textbox.on('submit', (val: string) => { safeResolve(val ?? options.initial); });
      textbox.key(KEY_CS, () => { safeResolve(getValue()); });
      confirmBtn.on('click', () => { safeResolve(getValue()); });

      // Cancel: Escape or click [Cancel] or click overlay
      textbox.on('cancel', () => { safeResolve(''); });
      cancelBtn.on('click', () => { safeResolve(''); });
      dialog.key(KEY_ESCAPE, () => { safeResolve(''); });
      overlay.on('click', () => { safeResolve(''); });

      overlay.setFront();
      dialog.setFront();
      textbox.focus();
      this.screen.render();
    });
  }

  async confirmTextbox(options: {
    title: string;
    message: string;
    confirmText: string;
    cancelLabel: string;
    width?: string | number;
    height?: string | number;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = this.createOverlay();
      const dialog = this.blessedImpl.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: options.width || '60%',
        height: options.height || 8,
        label: ` ${options.title} `,
        border: { type: 'line' },
        tags: true,
        mouse: true,
        clickable: true,
      }) as BlessedBox;

      const text = this.blessedImpl.box({
        parent: dialog,
        top: 1,
        left: 2,
        width: '100%-4',
        height: 3,
        content: options.message,
        tags: true,
      }) as BlessedText;
      void text;

      const input = this.blessedImpl.textbox({
        parent: dialog,
        bottom: 0,
        left: 2,
        width: '50%',
        height: 1,
        inputOnFocus: true,
      }) as BlessedTextbox;

      const cancelBtn = this.blessedImpl.box({
        parent: dialog,
        bottom: 0,
        right: 2,
        height: 1,
        width: options.cancelLabel.length + 2,
        content: `[${options.cancelLabel}]`,
        mouse: true,
        clickable: true,
        style: { fg: 'yellow' },
      }) as BlessedBox;

      const cleanup = () => {
        this.endTextboxReading(input);
        this.destroyWidgets([input, cancelBtn, dialog, overlay]);
        if (this.activeCleanup === cleanup) this.activeCleanup = null;
      };
      this.activeCleanup = cleanup;

      cancelBtn.on('click', () => { cleanup(); resolve(false); });
      input.on('submit', (val: string) => { cleanup(); resolve((val || '').trim() === options.confirmText); });
      dialog.key(KEY_ESCAPE, () => { cleanup(); resolve(false); });
      overlay.on('click', () => { cleanup(); resolve(false); });

      overlay.setFront();
      dialog.setFront();
      input.focus();
      this.screen.render();
    });
  }

  /**
   * Show a simple Yes / No confirmation dialog.
   *
   * Returns `true` if the user selects "Yes", `false` for "No", Escape, or
   * overlay click.  The dialog is keyboard-navigable (Tab between buttons,
   * Enter to select) and mouse-clickable.
   */
  async confirmYesNo(options: {
    title: string;
    message: string;
    width?: string | number;
    height?: string | number;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      let resolved = false;
      const overlay = this.createOverlay();
      const dialog = this.blessedImpl.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: options.width || '50%',
        height: options.height || 7,
        label: ` ${options.title} `,
        border: { type: 'line' },
        tags: true,
        mouse: true,
        clickable: true,
        style: { border: { fg: 'cyan' } },
      }) as BlessedBox;

      const text = this.blessedImpl.box({
        parent: dialog,
        top: 1,
        left: 2,
        width: '100%-4',
        height: 2,
        content: options.message,
        tags: true,
      }) as BlessedText;
      void text;

      const yesBtn = this.blessedImpl.box({
        parent: dialog,
        bottom: 0,
        left: 2,
        height: 1,
        width: 5,
        content: '[Yes]',
        mouse: true,
        clickable: true,
        style: { fg: 'green' },
      }) as BlessedBox;

      const noBtn = this.blessedImpl.box({
        parent: dialog,
        bottom: 0,
        left: 8,
        height: 1,
        width: 4,
        content: '[No]',
        mouse: true,
        clickable: true,
        style: { fg: 'yellow' },
      }) as BlessedBox;

      // Focus tracking for Tab navigation between Yes/No buttons
      let focusedBtn: 'yes' | 'no' = 'no';
      const focusYes = () => { focusedBtn = 'yes'; yesBtn.style.bold = true; noBtn.style.bold = false; this.screen.render(); };
      const focusNo = () => { focusedBtn = 'no'; yesBtn.style.bold = false; noBtn.style.bold = true; this.screen.render(); };
      focusNo();

      const cleanup = () => {
        this.destroyWidgets([yesBtn, noBtn, dialog, overlay]);
        if (this.activeCleanup === cleanup) this.activeCleanup = null;
      };
      this.activeCleanup = cleanup;

      const safeResolve = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(value);
      };

      yesBtn.on('click', () => { safeResolve(true); });
      noBtn.on('click', () => { safeResolve(false); });
      dialog.key(KEY_ESCAPE, () => { safeResolve(false); });
      overlay.on('click', () => { safeResolve(false); });

      // Tab / Shift-Tab to toggle between Yes and No
      dialog.key(['tab'], () => {
        if (focusedBtn === 'yes') focusNo();
        else focusYes();
      });
      dialog.key(['S-tab'], () => {
        if (focusedBtn === 'yes') focusNo();
        else focusYes();
      });

      // Enter confirms the currently focused button
      dialog.key(['enter'], () => {
        safeResolve(focusedBtn === 'yes');
      });

      overlay.setFront();
      dialog.setFront();
      dialog.focus();
      this.screen.render();
    });
  }

  // -- Non-interactive message box (status / progress) -----------------------

  /**
   * Show a non-interactive message box with dynamic content.
   *
   * Returns an imperative handle with `update(message)` and `close()` methods.
   * The caller controls the lifecycle — the dialog stays open until `close()`
   * is called.  Pressing Escape also closes the dialog.
   *
   * Useful for displaying multi-step progress (e.g., "Pushing to GitHub…"
   * then "Assigning @copilot…").
   */
  messageBox(options: {
    title: string;
    message: string;
    width?: string | number;
    height?: string | number;
  }): { update: (message: string) => void; close: () => void } {
    const overlay = this.createOverlay();
    const dialog = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: options.width || '60%',
      height: options.height || 7,
      label: ` ${options.title} `,
      border: { type: 'line' },
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'cyan' } },
    }) as BlessedBox;

    const text = this.blessedImpl.box({
      parent: dialog,
      top: 1,
      left: 2,
      width: '100%-4',
      height: '100%-3',
      content: options.message,
      tags: true,
    }) as BlessedBox;

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.destroyWidgets([text, dialog, overlay]);
      if (this.activeCleanup === cleanup) this.activeCleanup = null;
    };
    this.activeCleanup = cleanup;

    dialog.key(KEY_ESCAPE, () => { cleanup(); });
    overlay.on('click', () => { cleanup(); });

    overlay.setFront();
    dialog.setFront();
    dialog.focus();
    this.screen.render();

    return {
      update: (message: string) => {
        if (closed) return;
        try {
          text.setContent(message);
          this.screen.render();
        } catch (_) {}
      },
      close: () => { cleanup(); },
    };
  }

  // -- Private helpers -------------------------------------------------------

  private createOverlay(): BlessedBox {
    return this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100% - 1',
      mouse: true,
      clickable: true,
      style: { bg: 'black', fg: theme.tui.colors.lightText },
    }) as BlessedBox;
  }

  /**
   * End a textbox/textarea's readInput() cycle and release screen.grabKeys.
   *
   * Blessed textbox/textarea with inputOnFocus sets screen.grabKeys = true
   * when focused, which blocks all screen-level key handlers.  We must end
   * the readInput cycle before destroying the widget, otherwise grabKeys
   * stays true permanently.
   */
  private endTextboxReading(widget: any): void {
    try {
      if (widget._reading) {
        if (typeof widget.cancel === 'function' && widget.__listener) {
          widget.cancel();
        } else {
          widget._reading = false;
        }
      }
    } catch (_) {}
    this.releaseGrabKeys();
  }

  /** Reset screen.grabKeys and hide the terminal cursor. */
  private releaseGrabKeys(): void {
    try { this.screen.grabKeys = false; } catch (_) {}
    try { (this.screen as any).program?.hideCursor?.(); } catch (_) {}
  }

  /** Remove listeners and destroy a list of widgets. */
  private destroyWidgets(widgets: any[]): void {
    for (const w of widgets) {
      try { w.hide(); } catch (_) {}
    }
    for (const w of widgets) {
      try { w.removeAllListeners?.(); } catch (_) {}
    }
    for (const w of widgets) {
      try { w.destroy(); } catch (_) {}
    }
  }
}
