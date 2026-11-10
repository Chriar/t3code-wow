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
