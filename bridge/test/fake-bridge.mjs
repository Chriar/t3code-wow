// A stand-in for the bridge, for the supervisor's tests.
//
//   node fake-bridge.mjs <journal> [exit=CODE] [live=MS] [slow=MS] [deaf] --parent <pid>
//
// It appends one line of JSON to <journal> when it starts and one when it stops, so a
// test can see which bridges ran, when, and whether an earlier one was still running.
//
//   exit=CODE   exit with this code after live=MS (default 0 ms), like a bridge that crashes
//   slow=MS     take this long to stop once the supervisor is gone
//   deaf        never stop by itself, like a bridge that hangs
//
// Without exit= it runs until its supervisor is gone, as `t3code-wow run --parent` does.

import fs from 'node:fs';
import { stopWhenGone } from '../src/windows-service.js';

const [journal, ...words] = process.argv.slice(2);
const parent = Number(words[words.indexOf('--parent') + 1]);
const option = (name) => words.find((word) => word.startsWith(`${name}=`))?.split('=')[1];

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function earlierBridges() {
  try {
    const events = fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    return [...new Set(events.filter((e) => e.event === 'start').map((e) => e.pid))];
  } catch {
    return [];
  }
}

const write = (event) => fs.appendFileSync(journal, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`);
const stop = (code) => {
  write({ event: 'stop' });
  process.exit(code);
};

write({ event: 'start', parent, stillRunning: earlierBridges().filter(alive) });
console.log(`fake bridge ${process.pid} started`);

if (option('exit') !== undefined) {
  setTimeout(() => stop(Number(option('exit'))), Number(option('live') || 0));
} else {
  if (!words.includes('deaf')) stopWhenGone(parent, () => setTimeout(() => stop(0), Number(option('slow') || 0)), 100);
  setInterval(() => {}, 1000);
}
