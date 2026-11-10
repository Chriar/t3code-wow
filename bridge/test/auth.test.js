import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t3Command } from '../src/auth.js';

const windowsOnly = { skip: process.platform !== 'win32' && 'needs cmd.exe' };
const T3_CMD = 'C:\\Users\\me\\.t3\\bin\\t3.cmd';
const issue = ['auth', 'session', 'issue', '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '30d', '--label', 'WoW bridge', '--token-only'];

test('t3 runs as it is everywhere but a Windows batch file', () => {
  assert.deepEqual(t3Command('/usr/bin/t3', issue, 'linux'), ['/usr/bin/t3', issue, {}]);
  assert.deepEqual(t3Command('/Users/me/.t3/bin/t3', issue, 'darwin'), ['/Users/me/.t3/bin/t3', issue, {}]);
  assert.deepEqual(t3Command('/home/me/bin/t3.cmd', issue, 'linux'), ['/home/me/bin/t3.cmd', issue, {}]);
  assert.deepEqual(t3Command('C:\\Tools\\t3.exe', issue, 'win32'), ['C:\\Tools\\t3.exe', issue, {}]);
});

test('a Windows batch file runs through cmd.exe as one line with every part quoted', () => {
  const [file, argv, options] = t3Command(T3_CMD, ['auth', '--label', 'WoW bridge'], 'win32');
  assert.match(file, /cmd(\.exe)?$/i);
  assert.deepEqual(argv, ['/d', '/s', '/c', '""C:\\Users\\me\\.t3\\bin\\t3.cmd" "auth" "--label" "WoW bridge""']);
  assert.equal(options.windowsVerbatimArguments, true);
});

test('the arguments the bridge uses pass, and one cmd.exe would read as a command is refused', () => {
  t3Command(T3_CMD, issue, 'win32');
  t3Command(T3_CMD, ['auth', 'session', 'revoke', '0193b6f2-7c1e-7d3a-9f41-2a6c5e8d4b10'], 'win32');
  for (const arg of ['a & calc', 'a|b', '%PATH%', 'say "hi"', 'a^b', 'a!b', 'a<b', 'a>b', 'two\nlines', "it's"]) {
    assert.throws(() => t3Command(T3_CMD, ['auth', arg], 'win32'), /cmd\.exe/, arg);
  }
});

test("a batch file in a folder with accents, spaces or & is run, and one whose path cmd.exe can't carry is refused", () => {
  for (const folder of ['José Müller', 'Tom & Jerry', "O'Brien", 'DANIEL~1']) {
    const [, argv] = t3Command(`C:\\Users\\${folder}\\.t3\\bin\\t3.cmd`, ['--version'], 'win32');
    assert.equal(argv[3], `""C:\\Users\\${folder}\\.t3\\bin\\t3.cmd" "--version""`);
  }
  for (const folder of ['100%', '%USERNAME%', 'wow!']) {
    assert.throws(() => t3Command(`C:\\Users\\${folder}\\.t3\\bin\\t3.cmd`, ['--version'], 'win32'), /T3_CLI/, folder);
  }
});

test('a real batch file gets each argument whole, and its exit code comes back', windowsOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow é & cmd-'));
  try {
    const batch = path.join(dir, 't3.cmd');
    fs.writeFileSync(batch, '@echo off\r\necho 1=[%~1] 2=[%~2] 3=[%~3] 4=[%~4]\r\nexit /b 7\r\n');
    const [file, argv, options] = t3Command(batch, ['auth', '--label', 'WoW bridge', 'a(b)=c']);
    const ran = await new Promise((resolve) => {
      execFile(file, argv, { timeout: 20000, ...options }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout: stdout.trim() }));
    });
    assert.deepEqual(ran, { code: 7, stdout: '1=[auth] 2=[--label] 3=[WoW bridge] 4=[a(b)=c]' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
