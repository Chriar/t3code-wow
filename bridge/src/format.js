// Markdown -> WoW font-string markup, and markdown -> plain text for speech.

const GOLD = 'ffffd100';
const WHITE = 'ffffffff';
const CODE = 'ffa8c7fa';
const DIM = 'ff9d9d9d';

const color = (hex, s) => `|c${hex}${s}|r`;

// WoW treats "|" as an escape character; double it so text can't inject markup.
export function escapeWow(s) {
  return String(s ?? '').replace(/\|/g, '||');
}

function inline(line) {
  let s = escapeWow(line);
  // Inline code first so its contents aren't formatted further.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[image: $1]');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text) => text);
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, b) => color(WHITE, b));
  s = s.replace(/__([^_]+)__/g, (_, b) => color(WHITE, b));
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1$2');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => color(CODE, codes[Number(i)]));
  return s;
}

export function markdownToWow(md, { maxChars = 3500 } = {}) {
  let text = String(md ?? '').replace(/\r\n/g, '\n');
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  const out = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    const fence = /^\s*```/.test(raw);
    if (fence) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(color(CODE, '  ' + escapeWow(raw)));
      continue;
    }
    let m;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw))) {
      out.push(color(GOLD, inline(m[2])));
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(raw))) {
      const depth = Math.min(3, Math.floor(m[1].length / 2));
      out.push('  '.repeat(depth) + color(GOLD, '•') + ' ' + inline(m[2]));
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw))) {
      const depth = Math.min(3, Math.floor(m[1].length / 2));
      out.push('  '.repeat(depth) + color(GOLD, m[2] + '.') + ' ' + inline(m[3]));
    } else if (/^\s*>\s?/.test(raw)) {
      out.push(color(DIM, inline(raw.replace(/^\s*>\s?/, ''))));
    } else if (/^\s*([-*_]\s*){3,}$/.test(raw)) {
      out.push(color(DIM, '—————'));
    } else if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; // table separator row
      out.push(inline(raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ·  ')));
    } else {
      out.push(inline(raw));
    }
  }
  let s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (truncated) s += '\n' + color(DIM, '… (open the thread in T3 Code for the rest)');
  return s;
}

export function markdownToSpeech(md, { maxChars = 1500 } = {}) {
  let s = String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[*_~>|]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (s.length > maxChars) {
    const cut = s.lastIndexOf('. ', maxChars);
    s = s.slice(0, cut > maxChars / 2 ? cut + 1 : maxChars);
  }
  return s;
}

export function firstLine(md, max = 140) {
  const plain = markdownToSpeech(md, { maxChars: max * 3 }).split('\n').find((l) => l.trim()) || '';
  return plain.length > max ? plain.slice(0, max - 1) + '…' : plain;
}
