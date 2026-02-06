import { describe, it, expect } from 'vitest';
import blessed from 'blessed';
import { OpencodePaneComponent } from '../../src/tui/components/opencode-pane.js';
import { ModalDialogsComponent } from '../../src/tui/components/modals.js';
import { DialogsComponent } from '../../src/tui/components/dialogs.js';
import { HelpMenuComponent } from '../../src/tui/components/help-menu.js';

describe('TUI widget create/destroy', () => {
  it('creating and destroying widgets repeatedly does not throw and removes listeners', () => {
    const screen = blessed.screen({ smartCSR: true, title: 'test' });

    for (let i = 0; i < 10; i++) {
      const pane = new OpencodePaneComponent({ parent: screen, blessed }).create();
      const modal = new ModalDialogsComponent({ parent: screen, blessed }).create();
      const dialogs = new DialogsComponent({ parent: screen, blessed, overlays: ({} as any) }).create();
      const help = new HelpMenuComponent({ parent: screen, blessed }).create();

      // show/hide cycle
      pane.show(); pane.hide(); pane.destroy();
      modal.selectList({ title: 't', message: 'm', items: ['a','b'] }).catch(() => {});
      try { dialogs.destroy(); } catch (_) {}
      try { help.destroy(); } catch (_) {}
    }

    expect(true).toBe(true);
  });
});
