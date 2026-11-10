import { spawn } from 'node:child_process';
import { POWERSHELL } from '../src/windows.js';

/**
 * @param {string} file
 * @returns {Promise<() => Promise<void>>}
 */
export function holdOpen(file) {
  const script = "$f = [IO.File]::Open($env:T3WOW_HOLD, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()";
  const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: { ...process.env, T3WOW_HOLD: file },
  });
  const closed = new Promise((resolve) => child.once('exit', resolve));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    closed.then(() => reject(new Error(`couldn't hold ${file} open`)));
    child.stdout.once('data', () => resolve(() => {
      child.stdin.end();
      return closed;
    }));
  });
}
