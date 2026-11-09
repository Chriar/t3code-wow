import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModelSelection, modelChoices, chosenModelSelection } from '../src/t3.js';

const sel = (instanceId, model) => ({ instanceId, model, options: [] });
const providers = [
  { instanceId: 'codex', enabled: true },
  { instanceId: 'claude', enabled: true },
  { instanceId: 'off', enabled: false },
];

test('a configured default wins, project first', () => {
  const settings = { defaultModelSelection: sel('codex', 'a'), fallbackModelSelection: sel('codex', 'b') };
  assert.equal(pickModelSelection({ project: { id: 'p', defaultModelSelection: sel('claude', 'c') }, settings, providers }).model, 'c');
  assert.equal(pickModelSelection({ project: { id: 'p' }, settings, providers }).model, 'a');
  assert.equal(pickModelSelection({ settings: { fallbackModelSelection: sel('codex', 'b') }, providers }).model, 'b');
});

test('without defaults, the latest thread in the project, then anywhere', () => {
  const threads = [
    { projectId: 'p', createdAt: '2026-11-01T00:00:00Z', modelSelection: sel('codex', 'old-here') },
    { projectId: 'p', createdAt: '2026-11-05T00:00:00Z', modelSelection: sel('claude', 'new-here') },
    { projectId: 'q', createdAt: '2026-11-08T00:00:00Z', modelSelection: sel('codex', 'elsewhere') },
    { projectId: 'p', createdAt: '2026-11-09T00:00:00Z', modelSelection: sel('codex', 'deleted'), deletedAt: '2026-11-09T01:00:00Z' },
  ];
  const settings = { defaultModelSelection: null, fallbackModelSelection: null };
  assert.equal(pickModelSelection({ project: { id: 'p' }, settings, threads, providers }).model, 'new-here');
  assert.equal(pickModelSelection({ project: { id: 'none' }, settings, threads, providers }).model, 'elsewhere');
  assert.equal(pickModelSelection({ settings, threads: [], providers }), null);
});

test('models on a switched-off provider are skipped', () => {
  const threads = [
    { projectId: 'p', createdAt: '2026-11-09T00:00:00Z', modelSelection: sel('off', 'x') },
    { projectId: 'p', createdAt: '2026-11-01T00:00:00Z', modelSelection: sel('codex', 'y') },
  ];
  const got = pickModelSelection({ project: { id: 'p' }, settings: { defaultModelSelection: sel('off', 'z') }, threads, providers });
  assert.equal(got.model, 'y');
});

test('the model list leaves out switched-off providers and legacy models', () => {
  const list = modelChoices([
    { instanceId: 'codex', displayName: 'Codex', enabled: true, models: [{ slug: 'a', name: 'A' }, { slug: 'old', name: 'Old', isLegacy: true }] },
    { instanceId: 'off', enabled: false, models: [{ slug: 'z', name: 'Z' }] },
  ]);
  assert.deepEqual(list, [{ instanceId: 'codex', model: 'a', name: 'A', provider: 'Codex' }]);
});

test('a picked model keeps the options last used with it', () => {
  const providers = [
    { instanceId: 'codex', enabled: true, models: [{ slug: 'a' }, { slug: 'b' }] },
    { instanceId: 'off', enabled: false, models: [{ slug: 'z' }] },
  ];
  const high = [{ id: 'reasoningEffort', value: 'high' }];
  const low = [{ id: 'reasoningEffort', value: 'low' }];
  // The selection T3 would have used wins when it's the same model.
  const auto = { instanceId: 'codex', model: 'a', options: high };
  assert.deepEqual(chosenModelSelection({ instanceId: 'codex', model: 'a' }, { providers, candidates: [auto] }).options, high);
  // Otherwise the latest thread on that model.
  const threads = [
    { createdAt: '2026-11-01T00:00:00Z', modelSelection: { instanceId: 'codex', model: 'b', options: high } },
    { createdAt: '2026-11-05T00:00:00Z', modelSelection: { instanceId: 'codex', model: 'b', options: low } },
  ];
  assert.deepEqual(chosenModelSelection({ instanceId: 'codex', model: 'b' }, { providers, candidates: [auto], threads }).options, low);
  // Never used: no options, so T3 applies the model's defaults.
  assert.deepEqual(chosenModelSelection({ instanceId: 'codex', model: 'b' }, { providers }), { instanceId: 'codex', model: 'b' });
  assert.throws(() => chosenModelSelection({ instanceId: 'off', model: 'z' }, { providers }), /switched off/);
  assert.throws(() => chosenModelSelection({ instanceId: 'codex', model: 'gone' }, { providers }), /no longer offers/);
});
