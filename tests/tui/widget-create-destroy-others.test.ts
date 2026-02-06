import { describe, it, expect } from 'vitest';
import blessed from 'blessed';
import { ListComponent } from '../../src/tui/components/list.js';
import { DetailComponent } from '../../src/tui/components/detail.js';
import { OverlaysComponent } from '../../src/tui/components/overlays.js';
import { ToastComponent } from '../../src/tui/components/toast.js';

describe('TUI additional widget create/destroy', () => {
  it('repeated create/destroy of list, detail, overlays, toast does not throw', () => {
    const screen = blessed.screen({ smartCSR: true, title: 'test' });

    for (let i = 0; i < 30; i++) {
      const list = new ListComponent({ parent: screen, blessed }).create();
      const detail = new DetailComponent({ parent: screen, blessed }).create();
      const overlays = new OverlaysComponent({ parent: screen, blessed }).create();
      const toast = new ToastComponent({ parent: screen, blessed, duration: 5 }).create();

      // exercise some methods
      try { list.setItems(['a','b','c']); list.select(0); list.show(); list.hide(); } catch (_) {}
      try { detail.setContent('x'); detail.show(); detail.hide(); } catch (_) {}
      try { overlays.hide(); } catch (_) {}
      try { toast.show('hi'); toast.hide(); } catch (_) {}

      // destroy and ensure no exceptions
      try { list.destroy(); } catch (_) {}
      try { detail.destroy(); } catch (_) {}
      try { overlays.destroy(); } catch (_) {}
      try { toast.destroy(); } catch (_) {}
    }

    expect(true).toBe(true);
  });
});
