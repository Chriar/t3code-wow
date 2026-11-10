// For the tests of what only Windows does: refuse to replace or remove a file another
// program has open.

import { spawn } from 'node:child_process';
import { POWERSHELL } from '../src/windows.js';

/**
 * Another process opens the file for reading and lets others read it, but not write,
 * replace or delete it, the way the game might hold a file.
 * @param {string} file
 * @returns {Promise<() => Promise<void>>} A function that closes the file again.
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
