import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen, BlessedTextarea, BlessedText } from '../types.js';

export interface OpencodePaneComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class OpencodePaneComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;

  readonly serverStatusBox: BlessedBox;
  readonly dialog: BlessedBox;
  readonly textarea: BlessedTextarea;
  readonly suggestionHint: BlessedText;
  readonly sendButton: BlessedBox;
  readonly cancelButton: BlessedBox;

  private responsePane: BlessedBox | null = null;

  constructor(options: OpencodePaneComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    // Server status indicator (footer centered)
    this.serverStatusBox = this.blessedImpl.box({
      parent: this.screen,
      bottom: 0,
      left: 'center',
      width: 1,
      height: 1,
      content: '',
      tags: true,
      align: 'center',
      style: { fg: 'white' },
    });

    // Larger dialog and textbox for multi-line prompts
    this.dialog = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: '60%',
      label: ' Run opencode ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'white' }, label: { fg: 'white' } },
    });

    // Use a textarea so multi-line input works and Enter inserts newlines
    this.textarea = this.blessedImpl.textarea({
      parent: this.dialog,
      top: 1,
      left: 2,
      width: '100%-4',
      height: '100%-6',
      inputOnFocus: true,
      keys: true,
      vi: false,
      mouse: true,
      clickable: true,
      scrollable: true,
      alwaysScroll: true,
      border: { type: 'line' },
      style: { focus: { border: { fg: 'green' } } },
    });

    // Create a text element to show the suggestion below the input
    this.suggestionHint = this.blessedImpl.text({
      parent: this.dialog,
      top: '100%-4',
      left: 2,
      width: '100%-4',
      height: 1,
      tags: true,
      style: {
        fg: 'gray',
      },
      content: '',
    });

    this.sendButton = this.blessedImpl.box({
      parent: this.dialog,
      bottom: 0,
      right: 12,
      height: 1,
      width: 10,
      tags: true,
      content: '[ {underline}S{/underline}end ]',
      mouse: true,
      clickable: true,
      style: { fg: 'white', bg: 'green' },
    });

    this.cancelButton = this.blessedImpl.box({
      parent: this.dialog,
      top: 0,
      right: 1,
      height: 1,
      width: 3,
      content: '[x]',
      style: { fg: 'red' },
      mouse: true,
      clickable: true,
    });
  }

  create(): this {
    return this;
  }

  ensureResponsePane(options: {
    bottom: number;
    height: number;
    label: string;
    onEscape?: () => void;
  }): BlessedBox {
    if (this.responsePane) {
      this.responsePane.show();
      this.responsePane.setFront();
      this.responsePane.bottom = options.bottom;
      this.responsePane.height = options.height;
      this.responsePane.setLabel(options.label);
      return this.responsePane;
    }

    this.responsePane = this.blessedImpl.box({
      parent: this.screen,
      bottom: options.bottom,
      left: 0,
      width: '100%',
      height: options.height,
      label: options.label,
      border: { type: 'line' },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'magenta' } },
    });

    if (options.onEscape) {
      this.responsePane.key(['escape'], options.onEscape);
    }

    this.responsePane.show();
    this.responsePane.setFront();
    this.responsePane.focus();
    return this.responsePane;
  }

  getResponsePane(): BlessedBox | null {
    return this.responsePane;
  }

  show(): void {
    this.dialog.show();
  }

  hide(): void {
    this.dialog.hide();
    if (this.responsePane) this.responsePane.hide();
  }

  focus(): void {
    this.textarea.focus();
  }

  destroy(): void {
    try { this.cancelButton.destroy(); } catch (_) {}
    try { this.sendButton.destroy(); } catch (_) {}
    try { this.suggestionHint.destroy(); } catch (_) {}
    try { this.textarea.destroy(); } catch (_) {}
    try { this.dialog.destroy(); } catch (_) {}
    try { this.serverStatusBox.destroy(); } catch (_) {}
    if (this.responsePane) {
      try { this.responsePane.destroy(); } catch (_) {}
      this.responsePane = null;
    }
  }
}
