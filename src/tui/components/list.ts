import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedList, BlessedScreen } from '../types.js';

export interface ListComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class ListComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private list: BlessedList;
  private footer: BlessedBox;

  constructor(options: ListComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.list = this.blessedImpl.list({
      parent: this.screen,
      label: ' Work Items ',
      width: '50%',
      height: '100%-1',
      tags: true,
      keys: true,
      vi: false,
      mouse: true,
      scrollbar: { ch: ' ', track: { bg: 'grey' }, style: { bg: 'grey' } },
      style: {
        selected: { bg: 'blue' },
        border: { fg: 'white' },
        label: { fg: 'white' },
      },
      border: { type: 'line' },
      left: 0,
      top: 0,
    });

    this.footer = this.blessedImpl.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      height: 1,
      width: '100%',
      content: 'Press ? for help',
      style: { fg: 'grey' },
    });
  }

  create(): this {
    return this;
  }

  getList(): BlessedList {
    return this.list;
  }

  getFooter(): BlessedBox {
    return this.footer;
  }

  setItems(items: string[]): void {
    this.list.setItems(items);
  }

  select(index: number): void {
    this.list.select(index);
  }

  updateFooter(content: string): void {
    this.footer.setContent(content);
  }

  show(): void {
    this.list.show();
    this.footer.show();
  }

  hide(): void {
    this.list.hide();
    this.footer.hide();
  }

  focus(): void {
    this.list.focus();
  }

  destroy(): void {
    this.footer.destroy();
    this.list.destroy();
  }
}
