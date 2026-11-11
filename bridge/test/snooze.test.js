import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreset, snoozeChoices, snoozedUntil, presetId, DEFAULT_SNOOZE_PRESETS } from '../src/snooze.js';
import { threadStatus } from '../src/t3.js';

// A Tuesday, mid-afternoon, local time.
const now = new Date(2026, 10, 10, 14, 30, 0);

test('a relative preset lands that many minutes on, with no clock time to churn', () => {
  const c = resolvePreset({ kind: 'after', minutes: 120 }, now);
  assert.equal(c.id, 'after:120');
  assert.equal(c.label, 'In 2 hours');
  assert.equal(c.when, undefined);
  assert.equal(c.until.getTime(), now.getTime() + 120 * 60000);
  assert.equal(resolvePreset({ kind: 'after', minutes: 90 }, now).label, 'In 90 minutes');
  assert.equal(resolvePreset({ kind: 'after', minutes: 1440 }, now).label, 'In 1 day');
});

test('a fixed-time preset lands on its day, and is not offered once today\'s time has passed', () => {
  const evening = resolvePreset({ kind: 'at', day: 'today', time: '17:00' }, now);
  assert.equal(evening.label, 'This evening');
  assert.deepEqual([evening.until.getDate(), evening.until.getHours(), evening.until.getMinutes()], [10, 17, 0]);
  assert.equal(resolvePreset({ kind: 'at', day: 'today', time: '13:00' }, now), null);
  const tomorrow = resolvePreset({ kind: 'at', day: 'tomorrow', time: '05:00' }, now);
  assert.equal(tomorrow.label, 'Tomorrow');
  assert.deepEqual([tomorrow.until.getDate(), tomorrow.until.getHours()], [11, 5]);
});

test('a weekday preset means the next one, a week on when it is today', () => {
  const monday = resolvePreset({ kind: 'at', day: 'monday', time: '09:00' }, now);
  assert.equal(monday.label, 'Next week');
  assert.deepEqual([monday.until.getDate(), monday.until.getDay()], [16, 1]);
  assert.match(monday.when, /^Mon /);
  const tuesday = resolvePreset({ kind: 'at', day: 'tuesday', time: '09:00' }, now);
  assert.equal(tuesday.label, 'Next Tuesday');
  assert.equal(tuesday.until.getDate(), 17);
  assert.equal(resolvePreset({ kind: 'at', day: 'friday', time: '09:00' }, now).label, 'Friday');
});

test('choices come soonest first, without malformed presets or two on the same minute', () => {
  const presets = [
    { kind: 'at', day: 'monday', time: '09:00' },
    { kind: 'after', minutes: 150 },
    { kind: 'at', day: 'today', time: '17:00' },
    { kind: 'at', day: 'today', time: '13:00' },
    { kind: 'at', day: 'someday', time: '09:00' },
    { kind: 'at', day: 'today', time: '25:00' },
    { kind: 'after', minutes: 0 },
    null,
  ];
  assert.deepEqual(snoozeChoices(presets, now).map((c) => c.id), ['after:150', 'at:monday:09:00']);
  assert.equal(snoozeChoices(undefined, now).length, DEFAULT_SNOOZE_PRESETS.length);
  assert.equal(presetId({ kind: 'at', day: 'today', time: '18:00' }), 'at:today:18:00');
});

test('a thread is snoozed only while its time is still ahead', () => {
  const at = now.getTime();
  const later = new Date(at + 3600000).toISOString();
  const earlier = new Date(at - 1000).toISOString();
  assert.equal(snoozedUntil({ snoozedUntil: later }, at), at + 3600000);
  assert.equal(snoozedUntil({ snoozedUntil: earlier }, at), 0);
  assert.equal(snoozedUntil({ snoozedUntil: null }, at), 0);
  const t = { status: 'completed', snoozedUntil: later };
  assert.equal(threadStatus(t, at), 'snoozed');
  assert.equal(threadStatus({ ...t, snoozedUntil: earlier }, at), 'open');
  // Needing the player, or running, shows through a snooze. Snoozed shows over settled.
  assert.equal(threadStatus({ ...t, pendingRuntimeRequest: { kind: 'user_input' } }, at), 'input');
  assert.equal(threadStatus({ ...t, status: 'running' }, at), 'working');
  assert.equal(threadStatus({ ...t, settledOverride: 'settled' }, at), 'snoozed');
});

test('a typed snooze time reads as a length of time, a clock time or a day', async () => {
  const { parseCustomSnooze, describeWhen } = await import('../src/snooze.js');
  const at = (text) => {
    const d = parseCustomSnooze(text, now);
    return d && [d.getDate(), d.getHours(), d.getMinutes()];
  };
  // now is Tuesday the 10th, 14:30.
  assert.deepEqual(at('45m'), [10, 15, 15]);
  assert.deepEqual(at('3 hours'), [10, 17, 30]);
  assert.deepEqual(at('in 2 hours'), [10, 16, 30]);
  assert.deepEqual(at('1h30m'), [10, 16, 0]);
  assert.deepEqual(at('1.5h'), [10, 16, 0]);
  assert.deepEqual(at('an hour'), [10, 15, 30]);
  assert.deepEqual(at('2d'), [12, 14, 30]);
  assert.deepEqual(at('1 week'), [17, 14, 30]);
  assert.deepEqual(at('5pm'), [10, 17, 0]);
  assert.deepEqual(at('5:30 PM'), [10, 17, 30]);
  assert.deepEqual(at('at 5 p.m.'), [10, 17, 0]);
  assert.deepEqual(at('17:45'), [10, 17, 45]);
  assert.deepEqual(at('9am'), [11, 9, 0]); // already past today
  assert.deepEqual(at('noon'), [11, 12, 0]);
  assert.deepEqual(at('tomorrow'), [11, 9, 0]);
  assert.deepEqual(at('Tomorrow at 7:15 a.m.'), [11, 7, 15]);
  assert.deepEqual(at('tonight'), [10, 20, 0]);
  assert.deepEqual(at('fri 3pm'), [13, 15, 0]);
  assert.deepEqual(at('friday'), [13, 9, 0]);
  assert.deepEqual(at('tuesday 4pm'), [10, 16, 0]); // today, still ahead
  assert.deepEqual(at('tuesday 9am'), [17, 9, 0]); // today has passed: next week
  assert.deepEqual(at('2026-11-14 09:00'), [14, 9, 0]);
  for (const bad of ['', 'soon', '5', 'today 1pm', '2026-11-09 09:00', '2026-02-31', '25:00', '13pm', '0m', 'fri 3pm please']) {
    assert.equal(parseCustomSnooze(bad, now), null, bad);
  }
  assert.doesNotMatch(describeWhen(parseCustomSnooze('5pm', now), now), /[A-Za-z]{3} \d/);
  assert.match(describeWhen(parseCustomSnooze('fri 3pm', now), now), /^Fri /);
  assert.match(describeWhen(parseCustomSnooze('3w', now), now), /^Dec 1 /);
});
