// Snooze choices, worked out from T3 Code's own presets (Settings > Snooze), so the
// game offers the same times the app does.

export const DEFAULT_SNOOZE_PRESETS = [
  { kind: 'after', minutes: 60 },
  { kind: 'after', minutes: 180 },
  { kind: 'at', day: 'today', time: '18:00' },
  { kind: 'at', day: 'tomorrow', time: '09:00' },
  { kind: 'at', day: 'monday', time: '09:00' },
];

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function formatTime(date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function plural(n, unit) {
  return `In ${n} ${unit}${n === 1 ? '' : 's'}`;
}

function afterLabel(minutes) {
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

// Days from `now` to the preset's day. A weekday that is today means next week's.
function dayOffset(preset, now) {
  if (preset.day === 'today') return 0;
  if (preset.day === 'tomorrow') return 1;
  return (DAYS.indexOf(preset.day) - now.getDay() + 7) % 7 || 7;
}

function atLabel(preset, offset) {
  if (preset.day === 'today') {
    const hour = Number(preset.time.slice(0, 2));
    return hour < 12 ? 'This morning' : hour < 17 ? 'This afternoon' : 'This evening';
  }
  if (offset === 1) return 'Tomorrow';
  if (preset.day === 'monday') return 'Next week';
  return offset === 7 ? `Next ${cap(preset.day)}` : cap(preset.day);
}

export function presetId(preset) {
  return preset.kind === 'after' ? `after:${preset.minutes}` : `at:${preset.day}:${preset.time}`;
}

// One preset as a choice at `now`: { id, label, when, until }. `when` is the clock time
// for a fixed-time preset and absent for a relative one, whose time moves every minute.
// null when the preset's time today has already passed, or the preset is malformed.
export function resolvePreset(preset, now = new Date()) {
  if (preset?.kind === 'after' && Number.isInteger(preset.minutes) && preset.minutes > 0) {
    const until = new Date(now.getTime() + preset.minutes * 60000);
    return { id: presetId(preset), label: afterLabel(preset.minutes), until };
  }
  if (preset?.kind !== 'at' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(preset.time || '')) return null;
  if (preset.day !== 'today' && preset.day !== 'tomorrow' && !DAYS.includes(preset.day)) return null;
  const offset = dayOffset(preset, now);
  const until = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  until.setHours(Number(preset.time.slice(0, 2)), Number(preset.time.slice(3)), 0, 0);
  if (until.getTime() <= now.getTime()) return null;
  const label = atLabel(preset, offset);
  const time = formatTime(until);
  const sameDay = until.toDateString() === now.toDateString();
  const when = label !== 'Next week' || sameDay ? time : `${until.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return { id: presetId(preset), label, when, until };
}

// The choices to offer at `now`, soonest first, without two that land on the same minute.
export function snoozeChoices(presets, now = new Date()) {
  const seen = new Set();
  return (Array.isArray(presets) ? presets : DEFAULT_SNOOZE_PRESETS)
    .map((p) => resolvePreset(p, now))
    .filter(Boolean)
    .sort((a, b) => a.until - b.until)
    .filter((c) => {
      const minute = Math.floor(c.until.getTime() / 60000);
      return !seen.has(minute) && seen.add(minute);
    });
}

const UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

// "5pm", "5:30 pm", "17:00", "noon", "midnight" as [hours, minutes], or null.
function parseClock(text) {
  if (text === 'noon') return [12, 0];
  if (text === 'midnight') return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return null; // a bare number isn't a time
  let hours = Number(m[1]);
  const minutes = Number(m[2] || 0);
  if (m[3]) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  return hours < 24 && minutes < 60 ? [hours, minutes] : null;
}

// A time the player typed, as a Date after `now`, or null when it can't be read or
// has passed. Reads a length of time ("45m", "3 hours", "1h30m", "2d"), a clock time
// ("5pm", "17:30": today, or tomorrow once that has passed), and a day with an optional
// time ("tomorrow", "fri 3pm", "2026-11-14 09:00"; 9:00 when no time is given).
export function parseCustomSnooze(text, now = new Date()) {
  let s = String(text || '').toLowerCase().replace(/([ap])\.m\.?/g, '$1m').replace(/[,.]+(\s|$)/g, ' ');
  s = s.replace(/\b(in|at|for|until|till|on|an?)\b/g, (w) => (w === 'a' || w === 'an' ? '1' : ' ')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const future = (date) => (Number.isFinite(date.getTime()) && date.getTime() > now.getTime() ? date : null);

  // A length of time, possibly several parts.
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|wks?|w)(?![a-z])\s*/g)];
  if (parts.length && parts.map((p) => p[0]).join('').trim() === s) {
    const ms = parts.reduce((sum, p) => sum + Number(p[1]) * UNIT_MS[p[2][0]], 0);
    return ms >= 60000 ? future(new Date(now.getTime() + ms)) : null;
  }

  // A day, then maybe a time.
  const [first, ...rest] = s.split(' ');
  let day = null;
  let explicitDay = true;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(first);
  const weekday = DAY_NAMES[first] ?? DAYS.indexOf(first);
  if (first === 'today' || first === 'tonight') day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (first === 'tomorrow') day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  else if (iso) {
    day = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    if (day.getMonth() !== Number(iso[2]) - 1) return null;
  } else if (weekday >= 0) {
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((weekday - now.getDay() + 7) % 7));
  } else {
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    explicitDay = false;
  }
  const clockText = (explicitDay ? rest : [first, ...rest]).join(' ');
  const clock = clockText ? parseClock(clockText) : explicitDay ? (first === 'tonight' ? [20, 0] : [9, 0]) : null;
  if (!clock) return null;
  const at = new Date(day);
  at.setHours(clock[0], clock[1], 0, 0);
  if (at.getTime() > now.getTime()) return at;
  // Already past: a bare clock time means tomorrow's, a weekday means next week's.
  if (!explicitDay) at.setDate(at.getDate() + 1);
  else if (weekday >= 0 && !iso) at.setDate(at.getDate() + 7);
  return future(at);
}

// "5:00 PM", with the day when it isn't today.
export function describeWhen(date, now = new Date()) {
  const time = formatTime(date);
  if (date.toDateString() === now.toDateString()) return time;
  const week = date.getTime() - now.getTime() < 6 * 86400000;
  return `${date.toLocaleDateString(undefined, week ? { weekday: 'short' } : { month: 'short', day: 'numeric' })} ${time}`;
}

// When a thread's snooze ends, in ms, or 0 when it isn't snoozed at `now`.
export function snoozedUntil(t, now = Date.now()) {
  const until = t?.snoozedUntil ? Date.parse(t.snoozedUntil) : 0;
  return until > now ? until : 0;
}
