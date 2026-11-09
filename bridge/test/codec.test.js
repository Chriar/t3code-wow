import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { encodeFrame, decodeImage, renderCells, cellsToBytes, bytesToCells, MAX_PAYLOAD, parsePPM } from '../src/codec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lua = ['lua5.1', 'luajit', 'lua'].find((bin) => {
  try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
});

function luaCells(seq, payloadHex) {
  const script = `
    local ns = {}
    local chunk = assert(loadfile(${JSON.stringify(path.join(root, 'addon/T3Code/Core/Codec.lua'))}))
    chunk("T3Code", ns)
    local hex = ${JSON.stringify(payloadHex)}
    local s = hex:gsub("..", function(h) return string.char(tonumber(h, 16)) end)
    local cells = ns.Codec.Encode(${seq}, s)
    io.write(table.concat(cells, ","))
  `;
  return execFileSync(lua, ['-e', script]).toString().split(',').map(Number);
}

test('bytes <-> cells round trip', () => {
  const bytes = [0, 1, 2, 250, 255, 128, 77];
  assert.deepEqual(cellsToBytes(bytesToCells(bytes), bytes.length), bytes);
});

test('encode, render and decode', () => {
  const payload = 'B\x1fsess\x1fui\x1f1\x1f1\x1fo\x1f\x1f0\x1eC\x1f1\x1fsend\x1fthread-1\x1fhello ✓ 世界';
  const cells = encodeFrame(4242, payload);
  for (const cell of [2, 3, 4, 6]) {
    for (const [ox, oy] of [[0, 0], [1, 2], [5, 3]]) {
      const img = renderCells(cells, { cell, ox, oy, width: 160 * cell + 20, height: 60 * cell });
      const out = decodeImage(img);
      assert.ok(out && !out.error, `decode failed cell=${cell} ox=${ox} oy=${oy}: ${out?.error}`);
      assert.equal(out.seq, 4242);
      assert.equal(out.payload.toString('utf8'), payload);
    }
  }
});

test('no strip -> null; corrupted -> checksum error', () => {
  const blank = renderCells([], { width: 600, height: 100 });
  assert.equal(decodeImage(blank), null);
  const cells = encodeFrame(1, 'hello world');
  cells[40] = (cells[40] + 1) % 8;
  const out = decodeImage(renderCells(cells, { cell: 3 }));
  assert.equal(out.error, 'checksum mismatch');
});

test('max payload fits', () => {
  const payload = 'x'.repeat(MAX_PAYLOAD);
  const cells = encodeFrame(9, payload);
  const out = decodeImage(renderCells(cells, { cell: 3 }));
  assert.equal(out.payload.length, MAX_PAYLOAD);
  assert.throws(() => encodeFrame(9, payload + 'y'));
});

test('Lua encoder matches JS encoder', { skip: !lua && 'no lua interpreter' }, () => {
  const payload = Buffer.from('C\x1f7\x1fsend\x1fabc\x1fünïcödé | text', 'utf8');
  const fromLua = luaCells(65537, payload.toString('hex'));
  const fromJs = encodeFrame(1, payload);
  assert.deepEqual(fromLua, fromJs);
});

test('parse ppm', () => {
  const header = Buffer.from('P6\n# comment\n2 1\n255\n', 'latin1');
  const img = parsePPM(Buffer.concat([header, Buffer.from([255, 0, 0, 0, 255, 0])]));
  assert.equal(img.width, 2);
  assert.equal(img.data[3], 0);
  assert.equal(img.data[4], 255);
});
