import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Desktop, launchHelper, splitFrames } from '../src/windows.js';

const windowsOnly = { skip: process.platform !== 'win32' && 'needs Windows PowerShell' };
const FAKE = fileURLToPath(new URL('./fake-windows-helper.mjs', import.meta.url));

const wow = { pid: 4242, path: 'D:\\Games\\World of Warcraft\\_forever_\\Wow.exe', startMs: Date.UTC(2026, 10, 9, 9, 27, 45) };
const explorer = { pid: 77, path: 'C:\\Windows\\explorer.exe', startMs: Date.UTC(2026, 10, 9, 8, 0, 0) };

// A Desktop on the stand-in helper, and every helper it has started.
function fakeDesktop(scenario, options = {}) {
  const helpers = [];
  const launch = () => {
    helpers.push(spawn(process.execPath, [FAKE, JSON.stringify(scenario)], { stdio: ['pipe', 'pipe', 'pipe'] }));
    return helpers.at(-1);
  };
  return { desktop: new Desktop({ launch, ...options }), helpers };
}

// Desktop pauses before it starts another helper, so ask until one answers.
async function eventually(ask) {
  const end = Date.now() + 5000;
  for (;;) {
    try {
      return await ask();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(done, what) {
  const end = Date.now() + 5000;
  while (!done()) {
    assert.ok(Date.now() < end, `${what} within 5 s`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Fails where the suite would otherwise hang on something that never ends.
function within(ms, promise, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

test('replies cut anywhere by the pipe come out whole and in order', () => {
  const frame = (head, data = Buffer.alloc(0)) => Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, bytes: data.length })}\n`), data]);
  // Every byte value, so the data holds line ends that must not be read as one.
  const pixels = Buffer.from(Array.from({ length: 600 }, (_, i) => i % 256));
  const stream = Buffer.concat([frame({ id: 1 }, pixels), frame({ id: 2 }), frame({ id: 3 }, pixels.subarray(0, 5))]);
  for (let cut = 0; cut <= stream.length; cut++) {
    const first = splitFrames(stream.subarray(0, cut));
    const second = splitFrames(Buffer.concat([first.rest, stream.subarray(cut)]));
    const frames = [...first.frames, ...second.frames];
    assert.deepEqual(frames.map((f) => [f.head.id, f.data.length]), [[1, 600], [2, 0], [3, 5]], `cut at ${cut}`);
    assert.ok(frames[0].data.equals(pixels), `cut at ${cut}`);
    assert.equal(second.rest.length, 0);
  }
  assert.throws(() => splitFrames(Buffer.from('WARNING: something PowerShell printed\n')));
});

test('requests written back to back each get their own answer', async () => {
  const { desktop } = fakeDesktop({ procs: { Wow: [wow], explorer: [explorer] } });
  const answers = await Promise.all([desktop.processes('Wow'), desktop.processes('explorer'), desktop.processes('Retail'), desktop.processes('Wow')]);
  assert.deepEqual(answers, [[wow], [explorer], [], [wow]]);
  desktop.stop();
});

test('a helper that dies fails the request in flight, and a later request gets a new helper', async () => {
  const { desktop, helpers } = fakeDesktop({ procs: { Wow: [wow] }, exitAfter: 2 });
  assert.deepEqual(await desktop.processes('Wow'), [wow]);
  await assert.rejects(desktop.processes('Wow'));
  assert.deepEqual(await eventually(() => desktop.processes('Wow')), [wow]);
  assert.equal(helpers.length, 2);
  desktop.stop();
});

test('a helper that stops answering is killed and replaced', async () => {
  const { desktop, helpers } = fakeDesktop({ procs: { Wow: [wow] }, silentAfter: 2 }, { timeoutMs: 100 });
  assert.deepEqual(await desktop.processes('Wow'), [wow]);
  await assert.rejects(desktop.processes('Wow'));
  await until(() => !alive(helpers[0].pid), 'the silent helper is gone');
  assert.deepEqual(await eventually(() => desktop.processes('Wow')), [wow]);
  assert.equal(helpers.length, 2);
  desktop.stop();
});

test("a helper that can't start is reported with what PowerShell said, and not started again at once", async () => {
  const { desktop, helpers } = fakeDesktop({ neverReady: true });
  const reports = [];
  desktop.report = (message) => reports.push(message);
  await assert.rejects(desktop.processes('Wow'), /Cannot add type/);
  await assert.rejects(desktop.processes('Wow'), /Cannot add type/);
  assert.equal(helpers.length, 1);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /Cannot add type/);
});

test('a command that asked the desktop one question exits, and its helper goes with it', async () => {
  const script = `
    import { spawn } from 'node:child_process';
    import { Desktop } from ${JSON.stringify(new URL('../src/windows.js', import.meta.url).href)};
    const launch = () => {
      const helper = spawn(process.execPath, [${JSON.stringify(FAKE)}, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(helper.pid);
      return helper;
    };
    await new Desktop({ launch }).processes('Wow');
  `;
  // A command that hangs on its helper is killed after 10 s and fails the exit code check.
  const command = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 10000 });
  let printed = '';
  command.stdout.on('data', (d) => (printed += d));
  const [code] = await once(command, 'close');
  assert.equal(code, 0);
  const helper = Number(printed);
  assert.ok(helper > 0, 'the command started a helper');
  await until(() => !alive(helper), 'the helper is gone');
});

test("the real helper compiles under Windows PowerShell 5.1 and finds this test's own process", windowsOnly, async () => {
  let helper;
  const desktop = new Desktop({ launch: () => (helper = launchHelper()) });
  const me = (await desktop.processes(path.basename(process.execPath, '.exe'))).find((p) => p.pid === process.pid);
  assert.equal(me.path.toLowerCase(), process.execPath.toLowerCase());
  const started = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(me.startMs - started) < 2000, `started ${me.startMs}, expected about ${Math.round(started)} (ms since 1970 UTC)`);
  desktop.stop();
  const [code] = await within(5000, once(helper, 'exit'), 'the helper exits when its input closes');
  assert.equal(code, 0);
});

test('the real helper leaves when the bridge is gone, even with its input still open', windowsOnly, async () => {
  const bridge = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const helper = launchHelper(bridge.pid);
  try {
    await within(15000, once(helper.stdout, 'data'), 'the helper says it is ready');
    bridge.kill();
    const [code] = await within(5000, once(helper, 'exit'), 'the helper exits');
    assert.equal(code, 0);
  } finally {
    bridge.kill();
    helper.kill();
  }
});
