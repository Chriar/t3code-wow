// A thread's family, from the Fleet's thread map: where it came from and the threads
// that came from it. Direct relatives only; opening a child shows its own children.

import { threadStatus } from './t3.js';

// `up` is the thread's `_from` plus that thread when the map has it, or null. `kids`
// are the threads on any machine whose `_from` points at `key`, in the order they
// started, archived ones left out.
export function threadFamily(threads, key) {
  const from = threads.get(key)?._from;
  const up = from ? { ...from, thread: from.key ? threads.get(from.key) : undefined } : null;
  const started = (t) => Date.parse(t.createdAt) || 0;
  const kids = [...threads.values()]
    .filter((t) => t._from?.key === key && threadStatus(t) !== 'archived')
    .sort((a, b) => started(a) - started(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { up, kids };
}
