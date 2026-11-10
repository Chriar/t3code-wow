// A stand-in for the PowerShell helper, for tests.
//
// It speaks the protocol in src/windows-helper.cs over its own stdin and stdout, so
// the tests drive the real Desktop class (a real child process, pipes, framing and
// time limits) on Linux, macOS and Windows alike, with no PowerShell and no game.
//
//   node fake-windows-helper.mjs '<scenario as JSON>'

import readline from 'node:readline';

/**
 * What this "desktop" contains and how the helper misbehaves.
 * @typedef {object} Scenario
 * @property {Record<string, import('../src/windows.js').WinProcess[]>} [procs]  what `procs` returns, by the name asked for
 * @property {number} [exitAfter]     exit with code 3 instead of answering request number N
 * @property {number} [silentAfter]   stop answering from request number N on (a hung helper)
 * @property {boolean} [neverReady]   print to stderr and exit 1 before the hello (PowerShell locked down)
 */

/** @type {Scenario} */
const scenario = JSON.parse(process.argv[2] || '{}');

function send(head, data = Buffer.alloc(0)) {
  process.stdout.write(Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, bytes: data.length })}\n`), data]));
}

const operations = {
  procs: ({ name }) => [{ procs: scenario.procs?.[name] || [] }],
};

function serve() {
  send({ ready: true });
  let count = 0;
  const requests = readline.createInterface({ input: process.stdin });
  requests.on('line', (line) => {
    const request = JSON.parse(line);
    count++;
    if (count === scenario.exitAfter) process.exit(3);
    if (count >= scenario.silentAfter) return;
    const [fields, data] = operations[request.op](request);
    send({ id: request.id, ok: true, ...fields }, data);
  });
  requests.on('close', () => process.exit(0));
}

if (scenario.neverReady) {
  const said = 'Add-Type : Cannot add type. Definition of new types is not supported in this language mode.\nAt line:1 char:34\n';
  process.stderr.write(said, () => process.exit(1));
} else {
  serve();
}
