import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';

export interface ToastOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
  position?: {
    bottom?: number | string;
    right?: number | string;
    top?: number | string;
    left?: number | string;
  };
  style?: {
    fg?: string;
    bg?: string;
  };
  duration?: number;
}

export class ToastComponent {
  private blessedImpl: BlessedFactory;
  private box: BlessedBox;
  private screen: BlessedScreen;
  private timer: NodeJS.Timeout | null = null;
  private duration: number;

  constructor(options: ToastOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;
    this.duration = options.duration || 1200;

    // Create the toast box
    this.box = this.blessedImpl.box({
      parent: this.screen,
      bottom: options.position?.bottom ?? 1,
      right: options.position?.right ?? 1,
      top: options.position?.top,
      left: options.position?.left,
      height: 1,
      width: 12, // Will be adjusted based on content
      content: '',
      hidden: true,
      style: options.style || { fg: 'black', bg: 'green' },
    });
  }

  /**
   * Lifecycle method for parity with other components.
   * Creation happens in the constructor; this enables fluent usage.
   */
  create(): this {
    return this;
  }

  /**
   * Show a toast message
   */
  show(message: string): void {
    if (!message) return;
    
    const padded = ` ${message} `;
    this.box.setContent(padded);
    this.box.width = padded.length;
    this.box.show();
    this.screen.render();
    
    // Clear any existing timer
    if (this.timer) {
      clearTimeout(this.timer);
    }
    
    // Set new timer to hide the toast
    this.timer = setTimeout(() => {
      this.hide();
    }, this.duration);
  }

  /**
   * Hide the toast
   */
  hide(): void {
    this.box.hide();
    this.screen.render();
    
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Update toast styling
   */
  setStyle(style: { fg?: string; bg?: string }): void {
    if (style.fg) this.box.style.fg = style.fg;
    if (style.bg) this.box.style.bg = style.bg;
  }

  /**
   * Update toast position
   */
  setPosition(position: ToastOptions['position']): void {
    if (position?.bottom !== undefined) this.box.bottom = position.bottom;
    if (position?.right !== undefined) this.box.right = position.right;
    if (position?.top !== undefined) this.box.top = position.top;
    if (position?.left !== undefined) this.box.left = position.left;
  }

  /**
   * Destroy the toast component
   */
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Remove any attached event handlers before destroying the widget to avoid leaks
    // blessed widgets expose EventEmitter methods
    // (removeAllListeners is a safe no-op if none are attached)
    // Clear timers above then remove listeners and destroy
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - blessed types don't always include removeAllListeners
    if (typeof this.box.removeAllListeners === 'function') this.box.removeAllListeners();
    this.box.destroy();
  }
}
