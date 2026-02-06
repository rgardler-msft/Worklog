import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedScreen } from '../types.js';

export interface OverlaysComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
}

export class OverlaysComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;

  readonly detailOverlay: BlessedBox;
  readonly closeOverlay: BlessedBox;
  readonly updateOverlay: BlessedBox;

  constructor(options: OverlaysComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;

    this.detailOverlay = this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100% - 1',
      hidden: true,
      mouse: true,
      clickable: true,
      style: { bg: 'black' },
    });

    this.closeOverlay = this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100% - 1',
      hidden: true,
      mouse: true,
      clickable: true,
      style: { bg: 'black' },
    });

    this.updateOverlay = this.blessedImpl.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100% - 1',
      hidden: true,
      mouse: true,
      clickable: true,
      style: { bg: 'black' },
    });
  }

  create(): this {
    return this;
  }

  show(): void {
    // Overlays are shown individually.
  }

  hide(): void {
    this.detailOverlay.hide();
    this.closeOverlay.hide();
    this.updateOverlay.hide();
  }

  focus(): void {
    // No focusable element.
  }

  destroy(): void {
    // Remove listeners from overlays before destroying to avoid retaining handlers
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.detailOverlay.removeAllListeners === 'function') this.detailOverlay.removeAllListeners();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.closeOverlay.removeAllListeners === 'function') this.closeOverlay.removeAllListeners();
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof this.updateOverlay.removeAllListeners === 'function') this.updateOverlay.removeAllListeners();

    this.detailOverlay.destroy();
    this.closeOverlay.destroy();
    this.updateOverlay.destroy();
  }
}
