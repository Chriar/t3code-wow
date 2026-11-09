// Serialize plain JS data into a Lua 5.1 table literal. Only data: strings, numbers,
// booleans, arrays and plain objects. Everything the game loads from us goes through
// here, so nothing in a thread's text can ever become Lua code.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

export function luaString(value) {
  const buf = Buffer.from(String(value), 'utf8');
  let out = '"';
  for (const b of buf) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x0a) out += '\\n';
    else if (b < 0x20 || b === 0x7f) out += '\\' + String(b).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  // Each char of `out` is one byte (latin1), so writing it with 'latin1' reproduces
  // the original UTF-8 bytes exactly.
  return out + '"';
}

function key(k) {
  return IDENT.test(k) && !RESERVED.has(k) ? k : `[${luaString(k)}]`;
}

export function luaValue(v, depth = 0) {
  if (depth > 32) throw new Error('lua serialize: too deep');
  if (v === null || v === undefined) return 'nil';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) return '0';
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
    case 'string':
      return luaString(v);
    case 'object': {
      const parts = [];
      if (Array.isArray(v)) {
        for (const item of v) parts.push(luaValue(item, depth + 1));
      } else {
        for (const [k, item] of Object.entries(v)) {
          if (item === undefined || item === null) continue;
          parts.push(`${key(k)}=${luaValue(item, depth + 1)}`);
        }
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return 'nil';
  }
}

// The latin1 juggling above keeps raw UTF-8 bytes; write the result with 'latin1'.
export function luaAssignment(name, value) {
  return Buffer.from(`${name} = ${luaValue(value)}\n`, 'latin1');
}
