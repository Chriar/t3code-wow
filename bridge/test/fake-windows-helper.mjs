import fs from 'node:fs';
import readline from 'node:readline';

/**
 * @typedef {object} Scenario
 * @property {Record<string, import('../src/windows.js').WinProcess[]>} [procs]
 * @property {import('../src/windows.js').WinWindow[]} [windows]
 * @property {Record<string, 'ok'|'gone'|'minimized'|'cloaked'>} [states]
 * @property {'screen'|'window'} [via]
 * @property {number[]} [pixel]
 * @property {number[]} [jpeg]
 * @property {number} [exitAfter]
 * @property {number} [silentAfter]
 * @property {boolean} [neverReady]
 * @property {string} [log]
 */

/** @type {Scenario} */
const scenario = JSON.parse(process.argv[2] || '{}');

function send(head, data = Buffer.alloc(0)) {
  process.stdout.write(Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, bytes: data.length })}\n`), data]));
}

function onWindow(hwnd, answer) {
  const state = scenario.states?.[hwnd] || 'ok';
  if (state !== 'ok') return [{ state }];
  const [fields, data] = answer();
  return [{ state, ...fields }, data];
}

const operations = {
  procs: ({ name }) => [{ procs: scenario.procs?.[name] || [] }],
  windows: () => [{ windows: scenario.windows || [] }],
  grab: ({ hwnd, w, h }) => onWindow(hwnd, () => [{ via: scenario.via || 'screen', width: w, height: h }, Buffer.alloc(w * h * 3, Buffer.from(scenario.pixel || [0]))]),
  shot: ({ hwnd }) => onWindow(hwnd, () => [{ width: 2, height: 1 }, Buffer.from(scenario.jpeg || [])]),
};

function serve() {
  send({ ready: true });
  let count = 0;
  const requests = readline.createInterface({ input: process.stdin });
  requests.on('line', (line) => {
    const { id, ...request } = JSON.parse(line);
    count++;
    if (scenario.log) fs.appendFileSync(scenario.log, `${JSON.stringify(request)}\n`);
    if (count === scenario.exitAfter) process.exit(3);
    if (count >= scenario.silentAfter) return;
    const [fields, data] = operations[request.op](request);
    send({ id, ok: true, ...fields }, data);
  });
  requests.on('close', () => process.exit(0));
}

if (scenario.neverReady) {
  const said = 'Add-Type : Cannot add type. Definition of new types is not supported in this language mode.\nAt line:1 char:34\n';
  process.stderr.write(said, () => process.exit(1));
} else {
  serve();
}
