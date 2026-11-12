import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.js';
import { threadFamily } from '../src/family.js';

const at = (min) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString();

function thread(id, extra = {}) {
  return { id, projectId: 'p', title: id, status: 'completed', createdAt: at(0), updatedAt: at(0), lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id }, ...extra };
}

function sub(id, parent, extra = {}) {
  return thread(id, { lineage: { parentThreadId: parent, relationshipToParent: 'subagent', rootThreadId: parent }, forkedFrom: { type: 'node', nodeId: 'n1' }, ...extra });
}

// This machine and a laptop, fed the way T3 Code feeds them.
function machines() {
  const fleet = new Fleet({ localTokens: async () => 'x', environments: [{ code: 'e1', id: 'env-laptop', label: 'Laptop', urls: [] }] });
  const [desk, laptop] = fleet.envs;
  const shell = (env, threads) => env.client.onShell({ kind: 'snapshot', snapshot: { threads } });
  const deskConfig = () => desk.client.onConfig({ type: 'snapshot', config: { environment: { environmentId: 'env-desk', label: 'Desk' } } });
  return { fleet, desk, laptop, shell, deskConfig };
}

test('lineage ids become keys on the thread’s own machine, and each thread says where it came from', () => {
  const { fleet, desk, laptop, shell } = machines();
  shell(desk, [
    thread('root'),
    sub('kid', 'root'),
    thread('fork', { lineage: { parentThreadId: 'root', relationshipToParent: 'fork', rootThreadId: 'root' }, forkedFrom: { type: 'run', threadId: 'root', runId: 'r1' } }),
    thread('side', { lineage: { parentThreadId: 'root', relationshipToParent: 'fork', rootThreadId: 'root', sideChat: true } }),
  ]);
  shell(laptop, [thread('lroot'), sub('lkid', 'lroot')]);
  const t = (key) => fleet.threads.get(key);

  assert.equal(t('root')._from, null);
  assert.deepEqual([t('kid')._from.key, t('kid')._from.kind, t('kid')._from.env], ['root', 'sub', desk]);
  assert.equal(t('fork')._from.kind, 'fork');
  assert.equal(t('side')._from.kind, 'side');
  assert.deepEqual([t('kid').lineage.parentThreadId, t('kid').lineage.rootThreadId], ['root', 'root']);

  assert.equal(t('e1~lroot')._from, null);
  assert.deepEqual([t('e1~lkid')._from.key, t('e1~lkid')._from.kind, t('e1~lkid')._from.env], ['e1~lroot', 'sub', laptop]);
  assert.deepEqual([t('e1~lkid').lineage.parentThreadId, t('e1~lkid').lineage.rootThreadId], ['e1~lroot', 'e1~lroot'], 'a key the fleet routes to the laptop');
});

test('a thread sent from another machine points at the sender’s thread when the bridge knows that machine', () => {
  const { fleet, desk, laptop, shell, deskConfig } = machines();
  shell(desk, [
    thread('root'),
    thread('got', { delegatedFrom: { environmentId: 'env-laptop', threadId: 'lroot', title: 'Plan the release' } }),
    thread('stray', { delegatedFrom: { environmentId: 'env-elsewhere', threadId: 'x', title: 'From afar' } }),
  ]);
  // The laptop's threads arrive before this machine's config says which id it has.
  shell(laptop, [thread('lroot'), thread('back', { delegatedFrom: { environmentId: 'env-desk', threadId: 'root', title: 'Root' } })]);
  const t = (key) => fleet.threads.get(key);

  assert.deepEqual([t('got')._from.key, t('got')._from.kind, t('got')._from.env, t('got')._from.title], ['e1~lroot', 'sent', laptop, 'Plan the release']);
  assert.deepEqual([t('stray')._from.key, t('stray')._from.kind, t('stray')._from.env, t('stray')._from.title], [null, 'sent', undefined, 'From afar'], 'shown, but not openable');
  assert.equal(t('e1~back')._from.key, null, 'this machine’s id is not known yet');
  deskConfig();
  assert.deepEqual([t('e1~back')._from.key, t('e1~back')._from.env], ['root', desk], 'known once the config arrives');
});

test('a thread’s family is its parent and its direct children, oldest first, on any machine', () => {
  const { fleet, desk, laptop, shell, deskConfig } = machines();
  deskConfig();
  shell(desk, [
    thread('root', { status: 'running', activityRunStatus: 'running' }),
    sub('k2', 'root', { createdAt: at(2) }),
    sub('k1', 'root', { createdAt: at(1) }),
    sub('kb', 'root', { createdAt: at(1) }),
    sub('gone', 'root', { createdAt: at(1), archivedAt: at(5) }),
    sub('grandkid', 'k1', { createdAt: at(3) }),
    sub('orphan', 'not-in-the-shell'),
    thread('unrelated'),
  ]);
  shell(laptop, [thread('helper', { createdAt: at(4), delegatedFrom: { environmentId: 'env-desk', threadId: 'root', title: 'Root' } })]);

  const root = threadFamily(fleet.threads, 'root');
  assert.equal(root.up, null);
  assert.deepEqual(root.kids.map((t) => t.id), ['k1', 'kb', 'k2', 'e1~helper'], 'archived and grandchildren left out; a start-time tie goes by id');

  const kid = threadFamily(fleet.threads, 'k1');
  assert.deepEqual([kid.up.key, kid.up.kind, kid.up.thread], ['root', 'sub', fleet.threads.get('root')]);
  assert.deepEqual(kid.kids.map((t) => t.id), ['grandkid']);

  const helper = threadFamily(fleet.threads, 'e1~helper');
  assert.deepEqual([helper.up.key, helper.up.kind, helper.up.thread, helper.up.env], ['root', 'sent', fleet.threads.get('root'), desk]);

  const orphan = threadFamily(fleet.threads, 'orphan');
  assert.deepEqual([orphan.up.key, orphan.up.thread], ['not-in-the-shell', undefined], 'a parent the shell left out is still named');
  assert.deepEqual(threadFamily(fleet.threads, 'unrelated'), { up: null, kids: [] });
});
