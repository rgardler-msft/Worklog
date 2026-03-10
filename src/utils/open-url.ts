import * as fs from 'fs';

export async function openUrlInBrowser(url: string, fsImpl: typeof fs = fs): Promise<boolean> {
  // Prefer candidates based on environment; try each until one succeeds.
  const platform = process.platform;

  const isWsl = (() => {
    try {
      if (process.env.WSL_DISTRO_NAME) return true;
      const ver = fsImpl.readFileSync('/proc/version', 'utf8');
      return /microsoft/i.test(ver);
    } catch (_) {
      return false;
    }
  })();

  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(`open "${url}"`);
  } else if (platform === 'win32') {
    candidates.push(`powershell.exe Start "${url}"`);
  } else {
    // linux-like
    if (isWsl) {
      // prefer wslview if installed, then explorer.exe, then xdg-open
      candidates.push(`wslview "${url}"`);
      candidates.push(`explorer.exe "${url}"`);
      candidates.push(`xdg-open "${url}"`);
    } else {
      candidates.push(`xdg-open "${url}"`);
    }
  }

  try {
    const { exec } = await import('child_process');
    for (const cmd of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await new Promise<boolean>((resolve) => {
        try {
          exec(cmd, (err) => {
            resolve(!err);
          });
        } catch (_) {
          resolve(false);
        }
      });
      if (ok) return true;
    }
  } catch (_) {
    // ignore
  }
  return false;
}

export default openUrlInBrowser;
