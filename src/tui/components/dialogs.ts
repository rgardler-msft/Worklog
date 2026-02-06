import blessed from 'blessed';
import type { BlessedBox, BlessedFactory, BlessedList, BlessedScreen, BlessedTextarea } from '../types.js';
import type { OverlaysComponent } from './overlays.js';

export interface DialogsComponentOptions {
  parent: BlessedScreen;
  blessed?: BlessedFactory;
  overlays: OverlaysComponent;
}

export class DialogsComponent {
  private blessedImpl: BlessedFactory;
  private screen: BlessedScreen;
  private overlays: OverlaysComponent;

  readonly detailModal: BlessedBox;
  readonly detailClose: BlessedBox;

  readonly closeDialog: BlessedBox;
  readonly closeDialogText: BlessedBox;
  readonly closeDialogOptions: BlessedList;

  readonly updateDialog: BlessedBox;
  readonly updateDialogText: BlessedBox;
  readonly updateDialogOptions: BlessedList;
  readonly updateDialogStageOptions: BlessedList;
  readonly updateDialogStatusOptions: BlessedList;
  readonly updateDialogPriorityOptions: BlessedList;
  readonly updateDialogComment: BlessedTextarea;

  constructor(options: DialogsComponentOptions) {
    this.screen = options.parent;
    this.blessedImpl = options.blessed || blessed;
    this.overlays = options.overlays;

    this.detailModal = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: '70%',
      label: ' Item Details ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'green' } },
      content: '',
    });

    this.detailClose = this.blessedImpl.box({
      parent: this.detailModal,
      top: 0,
      right: 1,
      height: 1,
      width: 3,
      content: '[x]',
      style: { fg: 'red' },
      mouse: true,
    });

    this.closeDialog = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 10,
      label: ' Close Work Item ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'magenta' } },
    });

    this.closeDialogText = this.blessedImpl.box({
      parent: this.closeDialog,
      top: 1,
      left: 2,
      height: 2,
      width: '100%-4',
      content: 'Close selected item with stage:',
      tags: false,
    });

    this.closeDialogOptions = this.blessedImpl.list({
      parent: this.closeDialog,
      top: 4,
      left: 2,
      width: '100%-4',
      height: 4,
      keys: true,
      mouse: true,
      style: {
        selected: { bg: 'blue' },
      },
      items: ['Close (in_review)', 'Close (done)', 'Close (deleted)', 'Cancel'],
    });

    this.updateDialog = this.blessedImpl.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: 24,
      label: ' Update Work Item ',
      border: { type: 'line' },
      hidden: true,
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'magenta' } },
    });

    this.updateDialogText = this.blessedImpl.box({
      parent: this.updateDialog,
      top: 1,
      left: 2,
      height: 3,
      width: '100%-4',
      content: 'Update selected item fields:',
      tags: false,
    });

    const updateDialogColumnWidth = '33%-2';
    const updateDialogListHeight = 15;
    const updateDialogListTop = 6;

    this.blessedImpl.box({
      parent: this.updateDialog,
      top: 5,
      left: 2,
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Status',
      tags: false,
      style: { fg: 'cyan', bold: true },
    });

    this.blessedImpl.box({
      parent: this.updateDialog,
      top: 5,
      left: '33%+1',
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Stage',
      tags: false,
      style: { fg: 'cyan', bold: true },
    });

    this.blessedImpl.box({
      parent: this.updateDialog,
      top: 5,
      left: '66%+1',
      height: 1,
      width: updateDialogColumnWidth,
      content: 'Priority',
      tags: false,
      style: { fg: 'cyan', bold: true },
    });

    const statusList = this.blessedImpl.list({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: 2,
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      keys: true,
      mouse: true,
      style: {
        selected: { bg: 'blue' },
      },
      items: ['open', 'in-progress', 'blocked', 'completed', 'deleted'],
    });

    const stageList = this.blessedImpl.list({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: '33%+1',
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      keys: true,
      mouse: true,
      style: {
        selected: { bg: 'blue' },
      },
      items: ['idea', 'prd_complete', 'plan_complete', 'in_progress', 'in_review', 'done'],
    });

    const priorityList = this.blessedImpl.list({
      parent: this.updateDialog,
      top: updateDialogListTop,
      left: '66%+1',
      width: updateDialogColumnWidth,
      height: updateDialogListHeight,
      keys: true,
      mouse: true,
      style: {
        selected: { bg: 'blue' },
      },
      items: ['critical', 'high', 'medium', 'low'],
    });

    this.updateDialogOptions = stageList;
    this.updateDialogStageOptions = stageList;
    this.updateDialogStatusOptions = statusList;
    this.updateDialogPriorityOptions = priorityList;

    // Multiline comment textarea placed below the selection lists. It accepts
    // inputOnFocus so Enter inserts newlines; Tab/Shift-Tab navigation is
    // handled by focus management logic elsewhere.
    // Create the textarea without a hard-coded height. We'll position it
    // with `top` and `bottom` so it fills the available space inside the
    // dialog. This prevents it from rendering below the dialog on small
    // terminals and ensures it behaves as a multiline input.
    this.updateDialogComment = this.blessedImpl.textarea({
      parent: this.updateDialog,
      // initial placement; updateLayout will adjust on show/resize
      top: updateDialogListTop + updateDialogListHeight + 1,
      left: 2,
      right: 2,
      width: '100%-4',
      // Do not set `height` here — use `bottom` in updateLayout so the
      // textarea expands to available space inside the dialog.
      input: true,
      inputOnFocus: true,
      vi: true,
      wrap: true,
      keys: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      // Provide a visible, grey border and a title label
      border: { type: 'line' },
      label: ' Comment ',
      style: { fg: 'white', bg: 'black', border: { fg: 'gray' } },
      // show a scrollbar when text exceeds the box
      scrollbar: { ch: ' ', inverse: true },
    }) as BlessedTextarea;

    const updateLayout = () => {
      const screenHeight = Math.max(0, this.screen.height as number);
      const screenWidth = Math.max(0, this.screen.width as number);
      if (!screenHeight || !screenWidth) return;

      const extraCommentLines = screenHeight >= 28 ? 5 : 0;
      const textareaMinHeight = 4 + extraCommentLines;

      // Adjust overall dialog and list heights depending on screen size
      if (screenHeight < 28) {
        const height = Math.max(16, screenHeight - 4);
        this.updateDialog.height = height;
      } else {
        this.updateDialog.height = 24;
      }

      // Size lists to leave room for the comment box inside the dialog.
      const dialogHeight = Number(this.updateDialog.height as any) || 24;
      const listMaxHeight = Math.max(6, updateDialogListHeight - extraCommentLines);
      const listAvailable = dialogHeight - updateDialogListTop - textareaMinHeight - 3;
      const listHeight = Math.max(6, Math.min(listMaxHeight, listAvailable));
      stageList.height = listHeight;
      statusList.height = listHeight;
      priorityList.height = listHeight;

      // Position the comment textarea directly below the lists and let it
      // fill the remaining vertical space inside the dialog. Using a
      // `bottom` value (instead of explicit numeric `height`) keeps the
      // textarea responsive and prevents it from overflowing the dialog
      // when the terminal is small.
      const textareaTop = updateDialogListTop + listHeight + 1;
      // Position textarea to start below the lists and extend to 1 row above
      // the bottom border of the dialog. Using `bottom` ensures the control
      // remains inside the dialog even when the dialog shrinks.
      (this.updateDialogComment.top as any) = textareaTop;
      // Some terminals/versions of blessed behave better when we set an
      // explicit height rather than relying on `bottom`. Compute the height
      // available inside the dialog and clamp it to a reasonable minimum so
      // the textarea is always visible.
      // Leave 2 rows for dialog borders/spacing
      const available = dialogHeight - textareaTop - 2;
      const textareaHeight = Math.max(textareaMinHeight, available);
      (this.updateDialogComment.height as any) = textareaHeight;
      (this.updateDialogComment.left as any) = 2;
      (this.updateDialogComment.right as any) = 2;
      try { if (typeof this.updateDialogComment.show === 'function') this.updateDialogComment.show(); } catch (_) {}

      this.updateDialog.width = screenWidth < 100 ? '90%' : '70%';
    };

    this.updateDialog.on('show', updateLayout);
    this.screen.on('resize', updateLayout);
  }

  create(): this {
    return this;
  }

  getDetailOverlay(): any {
    return this.overlays.detailOverlay;
  }

  getCloseOverlay(): any {
    return this.overlays.closeOverlay;
  }

  getUpdateOverlay(): any {
    return this.overlays.updateOverlay;
  }

  show(): void {
    // Dialogs are shown individually.
  }

  hide(): void {
    this.detailModal.hide();
    this.closeDialog.hide();
    this.updateDialog.hide();
    this.overlays.hide();
  }

  focus(): void {
    // No single focus target.
  }

  destroy(): void {
    try { this.detailClose.removeAllListeners?.(); } catch (_) {}
    try { this.detailModal.removeAllListeners?.(); } catch (_) {}
    try { this.detailClose.destroy(); } catch (_) {}
    try { this.detailModal.destroy(); } catch (_) {}

    try { this.closeDialogOptions.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialogText.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialog.removeAllListeners?.(); } catch (_) {}
    try { this.closeDialogOptions.destroy(); } catch (_) {}
    try { this.closeDialogText.destroy(); } catch (_) {}
    try { this.closeDialog.destroy(); } catch (_) {}

    try { this.updateDialogOptions.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialogText.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialog.removeAllListeners?.(); } catch (_) {}
    try { this.updateDialogOptions.destroy(); } catch (_) {}
    try { this.updateDialogText.destroy(); } catch (_) {}
    try { this.updateDialog.destroy(); } catch (_) {}
  }
}
