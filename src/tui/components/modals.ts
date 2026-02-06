import blessed from 'blessed';
import type {
  BlessedBox,
  BlessedFactory,
  BlessedList,
  BlessedScreen,
  BlessedTextarea,
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
        try { dialog.hide(); overlay.hide(); } catch (_) {}
        try { list.removeAllListeners?.(); } catch (_) {}
        try { dialog.removeAllListeners?.(); } catch (_) {}
        try { overlay.removeAllListeners?.(); } catch (_) {}
        try { dialog.destroy(); } catch (_) {}
        try { overlay.destroy(); } catch (_) {}
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

      dialog.key(['escape'], () => {
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
      const overlay = this.createOverlay();
      const dialog = this.blessedImpl.box({
        parent: this.screen,
        top: 'center',
        left: 'center',
        width: options.width || '80%',
        height: options.height || '60%',
        label: ` ${options.title} `,
        border: { type: 'line' },
        tags: true,
        mouse: true,
        clickable: true,
      }) as BlessedBox;

      const textarea = this.blessedImpl.textarea({
        parent: dialog,
        top: 1,
        left: 1,
        width: '100%-2',
        height: '100%-4',
        inputOnFocus: true,
        keys: true,
        mouse: true,
        scrollable: true,
        alwaysScroll: true,
      }) as BlessedTextarea;

      try {
        if (typeof textarea.setValue === 'function') textarea.setValue(options.initial);
      } catch (_) {}

      const buttons = this.blessedImpl.list({
        parent: dialog,
        bottom: 0,
        left: 1,
        height: 1,
        width: '100%-2',
        items: [options.confirmLabel, options.cancelLabel],
        keys: true,
        mouse: true,
        style: { selected: { bg: 'blue' } },
      }) as BlessedList;

      buttons.select(0);

      const cleanup = () => {
        try { dialog.hide(); overlay.hide(); } catch (_) {}
        try { buttons.removeAllListeners?.(); } catch (_) {}
        try { textarea.removeAllListeners?.(); } catch (_) {}
        try { dialog.removeAllListeners?.(); } catch (_) {}
        try { overlay.removeAllListeners?.(); } catch (_) {}
        try { dialog.destroy(); } catch (_) {}
        try { overlay.destroy(); } catch (_) {}
      };

      buttons.on('select', (_el: any, idx: number) => {
        const value = textarea.getValue ? textarea.getValue() : options.initial;
        cleanup();
        resolve(idx === 0 ? value : '');
      });

      dialog.key(['escape'], () => {
        cleanup();
        resolve('');
      });

      overlay.on('click', () => {
        cleanup();
        resolve('');
      });

      overlay.setFront();
      dialog.setFront();
      textarea.focus();
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
        try { dialog.hide(); overlay.hide(); } catch (_) {}
        try { input.removeAllListeners?.(); } catch (_) {}
        try { cancelBtn.removeAllListeners?.(); } catch (_) {}
        try { dialog.removeAllListeners?.(); } catch (_) {}
        try { overlay.removeAllListeners?.(); } catch (_) {}
        try { dialog.destroy(); } catch (_) {}
        try { overlay.destroy(); } catch (_) {}
      };

      cancelBtn.on('click', () => {
        cleanup();
        resolve(false);
      });

      input.on('submit', (val: string) => {
        cleanup();
        resolve((val || '').trim() === options.confirmText);
      });

      dialog.key(['escape'], () => {
        cleanup();
        resolve(false);
      });

      overlay.on('click', () => {
        cleanup();
        resolve(false);
      });

      overlay.setFront();
      dialog.setFront();
      input.focus();
      this.screen.render();
    });
  }

  private createOverlay(): BlessedBox {
    return this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100% - 1',
      mouse: true,
      clickable: true,
      style: { bg: 'black' },
    }) as BlessedBox;
  }
}
