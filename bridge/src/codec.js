// Pixel strip codec, shared with addon/T3Code/Core/Codec.lua.
//
// Frame bytes:
//   [0x54 'T'] [0x33 '3'] [version] [seq hi, lo] [len hi, lo] [payload ...] [fletcher s1, s2]
// The Fletcher-16 checksum covers version..payload. Bytes are packed MSB-first into
// 3-bit cells. Each cell is a CELL x CELL square of physical pixels whose R, G and B
// channels are each fully on or off (bit 2 = R, bit 1 = G, bit 0 = B), laid out
// row-major, CELLS_PER_ROW cells per row, starting at the top-left of the game's UI.

export const MAGIC = [0x54, 0x33];
export const VERSION = 1; // plaintext (only ever a hello: the bridge ignores commands in it)
export const VERSIONS = new Set([1, 2]); // 2: encrypted, see strip-crypto.js
export const BITS = 3;
export const CELLS_PER_ROW = 160;
export const MAX_ROWS = 40;
export const HEADER_BYTES = 7;
export const MAX_PAYLOAD = Math.floor((CELLS_PER_ROW * MAX_ROWS * BITS) / 8) - HEADER_BYTES - 2;

export const US = '\x1f'; // field separator
export const RS = '\x1e'; // record separator

export function fletcher16(bytes, from = 0, to = bytes.length) {
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    s1 = (s1 + bytes[i]) % 255;
    s2 = (s2 + s1) % 255;
  }
  return [s1, s2];
}

export function encodeFrame(seq, payload, version = VERSION) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > MAX_PAYLOAD) throw new Error(`payload too large: ${body.length} > ${MAX_PAYLOAD}`);
  const bytes = [
    MAGIC[0], MAGIC[1], version,
    (seq >> 8) & 0xff, seq & 0xff,
    (body.length >> 8) & 0xff, body.length & 0xff,
    ...body,
  ];
  const [s1, s2] = fletcher16(bytes, 2, bytes.length);
  bytes.push(s1, s2);
  return bytesToCells(bytes);
}

export function bytesToCells(bytes) {
  const cells = [];
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= BITS) {
      const shift = nbits - BITS;
      cells.push((acc >> shift) & 0b111);
      nbits = shift;
      acc &= (1 << nbits) - 1;
    }
  }
  if (nbits > 0) cells.push((acc << (BITS - nbits)) & 0b111);
  return cells;
}

export function cellsToBytes(cells, count) {
  const out = [];
  let acc = 0;
  let nbits = 0;
  for (const c of cells) {
    acc = (acc << BITS) | c;
    nbits += BITS;
    if (nbits >= 8) {
      const shift = nbits - 8;
      out.push((acc >> shift) & 0xff);
      nbits = shift;
      acc &= (1 << nbits) - 1;
      if (count !== undefined && out.length >= count) break;
    }
  }
  return out;
}

export function cellsForBytes(n) {
  return Math.ceil((n * 8) / BITS);
}

// ---------------------------------------------------------------------------
// Image decoding. `img` is { width, height, data } with 3 bytes (RGB) per pixel.

function cellValueAt(img, x, y) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return -1;
  const i = (y * img.width + x) * 3;
  const r = img.data[i] >= 128 ? 4 : 0;
  const g = img.data[i + 1] >= 128 ? 2 : 0;
  const b = img.data[i + 2] >= 128 ? 1 : 0;
  return r | g | b;
}

function readCells(img, geo, start, n) {
  const { ox, oy, cell } = geo;
  const half = Math.floor(cell / 2);
  const cells = new Array(n);
  for (let k = 0; k < n; k++) {
    const idx = start + k;
    const col = idx % CELLS_PER_ROW;
    const row = Math.floor(idx / CELLS_PER_ROW);
    const v = cellValueAt(img, ox + col * cell + half, oy + row * cell + half);
    if (v < 0) return null;
    cells[k] = v;
  }
  return cells;
}

const HEADER_CELLS = cellsForBytes(HEADER_BYTES);

function headerAt(img, geo) {
  const cells = readCells(img, geo, 0, HEADER_CELLS);
  if (!cells) return null;
  const b = cellsToBytes(cells, HEADER_BYTES);
  if (b[0] !== MAGIC[0] || b[1] !== MAGIC[1] || !VERSIONS.has(b[2])) return null;
  return { version: b[2], seq: (b[3] << 8) | b[4], len: (b[5] << 8) | b[6] };
}

// Find the strip. Tries the last known geometry first, then searches cell sizes and
// small offsets (a window border or misaligned capture shifts the origin a little).
export function locate(img, hint) {
  if (hint && headerAt(img, hint)) return hint;
  for (let cell = 2; cell <= 8; cell++) {
    for (let oy = 0; oy <= cell * 3; oy++) {
      for (let ox = 0; ox <= cell * 3; ox++) {
        const geo = { ox, oy, cell };
        if (headerAt(img, geo)) return geo;
      }
    }
  }
  return null;
}

// Returns { version, seq, payload (Buffer), geo } or { error, geo } or null when no strip is visible.
export function decodeImage(img, hint) {
  const geo = locate(img, hint);
  if (!geo) return null;
  const head = headerAt(img, geo);
  if (head.len > MAX_PAYLOAD) return { error: 'bad length', geo };
  const total = HEADER_BYTES + head.len + 2;
  const cells = readCells(img, geo, 0, cellsForBytes(total));
  if (!cells) return { error: 'strip clipped by capture region', geo };
  const bytes = cellsToBytes(cells, total);
  const [s1, s2] = fletcher16(bytes, 2, HEADER_BYTES + head.len);
  if (bytes[total - 2] !== s1 || bytes[total - 1] !== s2) return { error: 'checksum mismatch', geo };
  return { version: head.version, seq: head.seq, payload: Buffer.from(bytes.slice(HEADER_BYTES, HEADER_BYTES + head.len)), geo };
}

// Render cells into an RGB image (for tests and the probe tool).
export function renderCells(cells, { cell = 3, ox = 0, oy = 0, width, height, background = [40, 40, 48] } = {}) {
  const rows = Math.ceil(cells.length / CELLS_PER_ROW);
  const w = width ?? ox + CELLS_PER_ROW * cell + 4;
  const h = height ?? oy + rows * cell + 4;
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    data[i * 3] = background[0];
    data[i * 3 + 1] = background[1];
    data[i * 3 + 2] = background[2];
  }
  cells.forEach((v, idx) => {
    const col = idx % CELLS_PER_ROW;
    const row = Math.floor(idx / CELLS_PER_ROW);
    for (let dy = 0; dy < cell; dy++) {
      for (let dx = 0; dx < cell; dx++) {
        const x = ox + col * cell + dx;
        const y = oy + row * cell + dy;
        if (x >= w || y >= h) continue;
        const p = (y * w + x) * 3;
        data[p] = v & 4 ? 255 : 0;
        data[p + 1] = v & 2 ? 255 : 0;
        data[p + 2] = v & 1 ? 255 : 0;
      }
    }
  });
  return { width: w, height: h, data };
}

// Parse a binary PPM (P6) as produced by `grim -t ppm`.
export function parsePPM(buf) {
  let pos = 0;
  const tokens = [];
  while (tokens.length < 4) {
    while (pos < buf.length && /\s/.test(String.fromCharCode(buf[pos]))) pos++;
    if (buf[pos] === 0x23) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    let start = pos;
    while (pos < buf.length && !/\s/.test(String.fromCharCode(buf[pos]))) pos++;
    tokens.push(buf.toString('latin1', start, pos));
  }
  pos++; // single whitespace after maxval
  const [magic, w, h, max] = tokens;
  if (magic !== 'P6') throw new Error('not a P6 ppm');
  const width = Number(w);
  const height = Number(h);
  if (Number(max) !== 255) throw new Error('unsupported ppm maxval');
  return { width, height, data: buf.subarray(pos, pos + width * height * 3) };
}
