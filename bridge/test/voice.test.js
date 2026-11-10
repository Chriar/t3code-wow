import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Voice } from '../src/voice.js';

test('a custom speech command gets the text on its standard input, through the shell of the system it runs on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3wow-voice-'));
  const heard = path.join(dir, 'heard.txt');
  const say = path.join(dir, 'say.cjs');
  fs.writeFileSync(say, "let text = ''; process.stdin.on('data', (d) => (text += d)).on('end', () => require('node:fs').writeFileSync(process.argv[2], text));");
  const voice = new Voice({ ttsCommand: `"${process.execPath}" "${say}" "${heard}"` });
  assert.equal(voice.speak('Für Elise, twice'), true);
  await new Promise((resolve) => voice.current.once('exit', resolve));
  assert.equal(fs.readFileSync(heard, 'utf8'), 'Für Elise, twice');
});
