import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlotBank } from '../src/slots.js';
import { holdOpen } from './hold-open.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'only Windows refuses to remove a file another program has open' };
const CLI = fileURLToPath(new URL('../bin/t3code-wow.js', import.meta.url));

function installed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow é cli-'));
  const at = (...parts) => path.join(dir, ...parts);
  const env = { ...process.env, XDG_CONFIG_HOME: at('config'), XDG_STATE_HOME: at('state'), XDG_DATA_HOME: at('data'), LOCALAPPDATA: at('local') };
  const wowDir = at('World of Warcraft', '_forever_');
  const addonsDir = path.join(wowDir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addonsDir, 'T3Code'), { recursive: true });
  fs.writeFileSync(path.join(addonsDir, 'T3Code', 'T3Code.toc'), '## Title: T3 Code\n');
  new SlotBank(addonsDir, { slots: 2 }).install();
  const config = at('config', 't3code-wow', 'config.json');
  const script = at('data', 't3code-wow', 'bridge', 'bin', 't3code-wow.js');
  const shim = at('local', 'Microsoft', 'WindowsApps', 't3code-wow.cmd');
  for (const file of [config, script, shim, at('state', 't3code-wow', 'state.json')]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ wowDir, addonsDir, slots: 2 }));
  fs.writeFileSync(script, '');
  fs.writeFileSync(shim, `@(goto) 2>nul & node "${script}" %*\r\n`);
  fs.writeFileSync(at('state', 't3code-wow', 'state.json'), '{}');
  return { addonsDir, config, shim, at, run: (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }) };
}

test('uninstall stops at a game file another program has open, with its settings intact, and finishes when run again', windowsOnly, async () => {
  const box = installed();
  const release = await holdOpen(path.join(box.addonsDir, 'T3Code', 'T3Code.toc'));
  let first;
  try {
    first = box.run('uninstall', '--yes');
  } finally {
    await release();
  }
  assert.equal(first.status, 1);
  assert.match(first.stderr, /AddOns\\T3Code can't be changed right now/);
  assert.ok(fs.existsSync(box.config), 'the settings that say where the game is are still there');

  const second = box.run('uninstall', '--yes');
  assert.equal(second.status, 0, second.stderr);
  for (const left of [path.join(box.addonsDir, 'T3Code'), box.at('config', 't3code-wow'), box.at('state', 't3code-wow'), box.at('data', 't3code-wow'), box.shim]) {
    assert.equal(fs.existsSync(left), false, left);
  }
});
