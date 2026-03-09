import { spawn } from 'child_process';
import * as os from 'os';

export type SpawnLike = (...args: any[]) => any;

/**
 * Copy text to the clipboard.
 *
 * Strategy:
 * 1. If running inside tmux ($TMUX is set), use `tmux set-buffer` so that
 *    tmux paste (prefix + ]) and any shell Ctrl+V bindings that read tmux
 *    buffers work immediately.
 * 2. Try to set the system clipboard as well (OSC 52, then platform tools)
 *    so that GUI applications can also paste the text.
 * 3. On macOS use pbcopy; on Windows use clip; on Linux try wl-copy (if
 *    WAYLAND_DISPLAY is set), then xclip, then xsel.
 *
 * The function reports success if at least one method succeeds.
 */
export async function copyToClipboard(
  text: string,
  opts?: { spawn?: SpawnLike; writeOsc52?: (seq: string) => void; env?: Record<string, string | undefined> },
): Promise<{ success: boolean; error?: string }> {
  const spawnImpl = opts?.spawn ?? spawn;
  const env = opts?.env ?? process.env;
  let anySuccess = false;
  const errors: string[] = [];

  // --- Helper: run a command, pipe `text` to its stdin ----------------------
  const run = (cmd: string, args: string[]) => new Promise<{ code: number | null; error?: Error }>((resolve) => {
    try {
      // Spawn in a detached process group so clipboard daemons (e.g. xclip)
      // survive when the parent TUI process group receives signals or tears
      // down the terminal.
      const cp = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      let handled = false;
      cp.on('error', (err: Error) => { if (!handled) { handled = true; resolve({ code: null, error: err }); } });
      cp.on('close', (code: number) => {
        if (!handled) { handled = true; resolve({ code }); }
        // Allow the Node process to exit without waiting for the detached
        // clipboard daemon (e.g. xclip forks a background process to serve
        // the X11 selection). We call unref() only after the close event
        // fires so we don't lose the event.
        try { if (typeof cp.unref === 'function') cp.unref(); } catch (_) {}
      });
      if (!cp.stdin || typeof cp.stdin.write !== 'function') {
        if (!handled) { handled = true; resolve({ code: null, error: new Error('stdin not available') }); }
        return;
      }
      try {
        cp.stdin.write(String(text));
        cp.stdin.end();
      } catch (writeErr: any) {
        try { cp.stdin.end(); } catch (_) {}
        if (!handled) { handled = true; resolve({ code: null, error: writeErr instanceof Error ? writeErr : new Error(String(writeErr)) }); }
      }
    } catch (err: any) {
      resolve({ code: null, error: err });
    }
  });

  // --- Helper: run a command with arguments (no stdin) ----------------------
  const runArgs = (cmd: string, args: string[]) => new Promise<{ code: number | null; error?: Error }>((resolve) => {
    try {
      const cp = spawnImpl(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      let handled = false;
      cp.on('error', (err: Error) => { if (!handled) { handled = true; resolve({ code: null, error: err }); } });
      cp.on('close', (code: number) => {
        if (!handled) { handled = true; resolve({ code }); }
        try { if (typeof cp.unref === 'function') cp.unref(); } catch (_) {}
      });
    } catch (err: any) {
      resolve({ code: null, error: err });
    }
  });

  try {
    // ----- 1. tmux paste buffer ---------------------------------------------
    // When running inside tmux, set the tmux paste buffer so that the user
    // can paste with `prefix + ]` (or Ctrl+V if their shell/tmux binds it).
    if (env.TMUX) {
      const res = await runArgs('tmux', ['set-buffer', '--', String(text)]);
      if (res.code === 0) {
        anySuccess = true;
      } else {
        errors.push(res.error?.message || 'tmux set-buffer failed');
      }
    }

    // ----- 2. WSL / OSC 52 -------------------------------------------------
    // Special-case: when running inside WSL, try the Windows clipboard helper
    // (`clip.exe`) via interop. This helps common setups where tmux runs in
    // WSL but the user expects the Windows clipboard to be updated.
    const isWSL = typeof env.WSL_DISTRO_NAME === 'string' || typeof env.WSL_INTEROP === 'string' || /microsoft/i.test(os.release());
    if (isWSL) {
      try {
        const clipRes = await run('clip.exe', []);
        if (clipRes.code === 0) {
          anySuccess = true;
        } else if (clipRes.error) {
          errors.push(clipRes.error.message);
        }
      } catch (e: any) {
        errors.push(e?.message || 'clip.exe failed');
      }
    }

    // ----- 3. OSC 52 --------------------------------------------------------
    // Write an OSC 52 escape sequence. If the terminal (or tmux with
    // set-clipboard on) supports it, this also sets the system clipboard.
    if (opts?.writeOsc52) {
      try {
        const b64 = Buffer.from(String(text)).toString('base64');
        opts.writeOsc52(`\x1b]52;c;${b64}\x07`);
        anySuccess = true;
      } catch (e: any) {
        errors.push(e?.message || 'OSC 52 write failed');
      }
    }

    // ----- 3. Platform clipboard tools --------------------------------------
    const plat = process.platform;
    if (plat === 'darwin') {
      const res = await run('pbcopy', []);
      if (res.code === 0) { anySuccess = true; }
      else { errors.push(res.error?.message || 'pbcopy failed'); }
    } else if (plat === 'win32') {
      const res = await run('cmd', ['/c', 'clip']);
      if (res.code === 0) { anySuccess = true; }
      else { errors.push(res.error?.message || 'clip failed'); }
    } else {
      // Linux / other: try wl-copy (Wayland), then xclip, then xsel
      let systemClipOk = false;
      if (env.WAYLAND_DISPLAY) {
        const wlcopy = await run('wl-copy', []);
        if (wlcopy.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (wlcopy.error) { errors.push(wlcopy.error.message); }
      }
      if (!systemClipOk) {
        const xclip = await run('xclip', ['-selection', 'clipboard']);
        if (xclip.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (xclip.error) { errors.push(xclip.error.message); }
      }
      if (!systemClipOk) {
        const xsel = await run('xsel', ['--clipboard', '--input']);
        if (xsel.code === 0) { anySuccess = true; systemClipOk = true; }
        else if (xsel.error) { errors.push(xsel.error.message); }
      }
      if (!systemClipOk && !anySuccess && errors.length === 0) {
        errors.push('clipboard command not available (install xclip, xsel, or wl-copy)');
      }
    }

    if (anySuccess) return { success: true };
    return { success: false, error: errors.join('; ') || 'no clipboard method available' };
  } catch (err: any) {
    if (anySuccess) return { success: true };
    return { success: false, error: err?.message || String(err) };
  }
}
