import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';

export interface DetailComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class DetailComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private detail: BlessedBox;
  private copyIdButton: BlessedBox;

  constructor(options: DetailComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.detail = this.blessedImpl.box({
      parent: this.screen,
      label: ' Details ',
      left: '50%',
      width: '50%',
      height: '100%-1',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      border: { type: 'line' },
      style: { focus: { border: { fg: 'green' } }, border: { fg: 'white' }, label: { fg: 'white' } },
      content: '',
    });

    this.copyIdButton = this.blessedImpl.box({
      parent: this.detail,
      top: 0,
      right: 1,
      height: 1,
      width: 11,
      content: '[Copy ID]',
      tags: false,
      mouse: true,
      align: 'right',
      style: { fg: 'yellow' },
    });
  }

  create(): this {
    return this;
  }

  getDetail(): BlessedBox {
    return this.detail;
  }

  getCopyIdButton(): BlessedBox {
    return this.copyIdButton;
  }

  setContent(content: string): void {
    this.detail.setContent(content);
  }

  focus(): void {
    this.detail.focus();
  }

  show(): void {
    this.detail.show();
  }

  hide(): void {
    this.detail.hide();
  }

  destroy(): void {
    this.copyIdButton.destroy();
    this.detail.destroy();
  }
}
