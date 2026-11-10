// Windows: the game's window, its pixels and the list of running programs.
//
// Node can't call the Windows API, and starting PowerShell for each capture costs
// 0.3 to 1.3 s, far too slow for a loop that runs every 150 ms. So one PowerShell
// process stays running for as long as the bridge does. It compiles windows-helper.cs
// when it starts (Add-Type, part of the Windows PowerShell 5.1 that ships with Windows,
// so there's nothing to install or build) and then answers requests on its standard
// input and output:
//
//   bridge -> helper   one line of JSON   {"id":7,"op":"grab","hwnd":329842,"w":672,"h":192}
//   helper -> bridge   one line of JSON   {"id":7,"ok":true,"state":"ok","via":"screen","width":672,"height":192,"bytes":387072}
//                      then exactly `bytes` raw bytes (packed RGB, or a JPEG file)
//
// The helper answers one request at a time, in the order they were written, so the
// bridge may write several without waiting. Nothing outside this file sees a line of
// that protocol, a window handle or the child process.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One running program, as the helper reports it.
 * @typedef {object} WinProcess
 * @property {number} pid
 * @property {string|null} path  Full path of its .exe. Null when Windows won't say.
 * @property {number} startMs    When it started, in ms since 1970 UTC. Windows records this
 *                               once per process, so pid and startMs together name one run
 *                               of a program even after the pid is reused.
 */

/**
 * One top-level window, as the helper reports it. Positions and sizes are in physical
 * pixels of the whole desktop (the helper is per-monitor DPI aware), so a monitor to
 * the left of or above the main one gives negative x or y.
 * @typedef {object} WinWindow
 * @property {number} hwnd
 * @property {number} pid
 * @property {string} className   "waApplication Window" for the game.
 * @property {string} title
 * @property {boolean} visible    False for the hidden helper windows a program owns.
 * @property {boolean} minimized  Windows gives a minimized window an empty client area, so its size says nothing.
 * @property {number} x           Left edge of the client area, the part the game draws.
 * @property {number} y           Top edge of the client area.
 * @property {number} width       Client area width.
 * @property {number} height      Client area height.
 */

/** @typedef {{ width: number, height: number, data: Buffer }} RgbImage  Packed 8-bit RGB, row-major, as codec.js reads it. */

/**
 * What StripCapture.grab() returns. `via` says how the pixels were read ('screen' or
 * 'window', see Desktop.grab) and is only there for people debugging the link.
 * @typedef {{ status: 'ok', image: RgbImage, via: 'screen'|'window' } | { status: 'no-window' } | { status: 'hidden' }} GrabResult
 */

/** @typedef {{ head: Record<string, any>, data: Buffer }} Frame  One reply from the helper. */

export const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HELPER_SRC = fileURLToPath(new URL('./windows-helper.cs', import.meta.url));

// A command string, not a script file, so the execution policy doesn't apply. The
// path travels in the environment, so no path needs quoting in PowerShell's syntax.
const BOOT = "$ErrorActionPreference = 'Stop'; Add-Type -LiteralPath $env:T3WOW_HELPER_SRC -ReferencedAssemblies System.Drawing,System.Web.Extensions; [T3CodeWow.Helper]::Run()";

const READY_TIMEOUT_MS = 15000; // compiling takes 0.3 to 1.3 s here; a cold disk or a virus scan can take longer
const WINDOW_CACHE_MS = 2000; // the same age the macOS and KWin lookups allow
const RESTART_AFTER_MS = [0, 1000, 2000, 5000, 15000, 30000]; // by how many helpers in a row have failed

/**
 * Starts the real helper. Tests pass Desktop their own launcher (a Node script that
 * speaks the same protocol), which is how Desktop runs under `node --test` on any
 * system without PowerShell or a game.
 * @param {number} [parentPid]  The helper exits when this process is gone.
 * @returns {import('node:child_process').ChildProcess}
 */
export function launchHelper(parentPid = process.pid) {
  return spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', BOOT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, T3WOW_HELPER_SRC: HELPER_SRC, T3WOW_PARENT_PID: String(parentPid) },
  });
}

/**
 * The complete frames at the start of `buffer`, and the bytes left over.
 * @param {Buffer} buffer
 * @returns {{ frames: Frame[], rest: Buffer }}
 * @throws {Error} when a line isn't a frame's JSON. The caller restarts the helper.
 */
export function splitFrames(buffer) {
  const frames = [];
  let at = 0;
  for (;;) {
    const lineEnd = buffer.indexOf(0x0a, at);
    if (lineEnd < 0) break;
    const head = JSON.parse(buffer.toString('utf8', at, lineEnd));
    if (!Number.isInteger(head?.bytes) || head.bytes < 0) throw new Error('a reply without its size');
    const end = lineEnd + 1 + head.bytes;
    if (buffer.length < end) break;
    frames.push({ head, data: buffer.subarray(lineEnd + 1, end) });
    at = end;
  }
  return { frames, rest: buffer.subarray(at) };
}

/**
 * The game's window among the helper's list: the largest visible window the client's
 * process owns, else one titled exactly "World of Warcraft". Hidden and tiny windows
 * (tooltips, IME, the launcher's splash) are never the game. A minimized game still
 * counts, so the bridge reports it as hidden instead of missing.
 * @param {WinWindow[]} windows
 * @param {number|undefined} pid
 * @returns {{ found: false } | { found: true, hwnd: number }}
 */
export function pickWinWindow(windows, pid) {
  const real = windows.filter((w) => w.visible && (w.minimized || (w.width > 100 && w.height > 100)));
  const mine = real.filter((w) => pid && w.pid === pid);
  const pool = mine.length ? mine : real.filter((w) => w.title === 'World of Warcraft');
  const area = (w) => w.width * w.height;
  const win = pool.sort((a, b) => Number(a.minimized) - Number(b.minimized) || area(b) - area(a))[0];
  return win ? { found: true, hwnd: win.hwnd } : { found: false };
}

// Why there's no screenshot, by the state the helper reports for the window.
const NO_SHOT = {
  gone: "couldn't find the game window",
  minimized: 'the game window is minimized',
  cloaked: 'the game window is on another desktop',
};

// PowerShell prints an error as its message, hard-wrapped at the width of a console
// nobody sees, then where in the command it happened.
export const whatPowerShellSaid = (stderr) => stderr.split(/\r?\nAt line:/)[0].replace(/\r?\n/g, '').trim().slice(0, 300);

/**
 * The Windows desktop, through one long-lived helper process.
 *
 * The helper's life, as a table. `queue` is the requests written but not yet answered.
 *
 *   state     event                                   next      what happens
 *   idle      a request, at or after `retryAt`        starting  launch; write the request
 *   idle      a request before `retryAt`              idle      reject at once with the last error
 *   starting  the hello frame                         ready
 *   starting  exit, or READY_TIMEOUT_MS without hello idle      fail(what PowerShell printed on stderr)
 *   ready     a reply frame whose id heads the queue  ready     resolve it; failures = 0
 *   ready     exit                                    idle      fail('the helper stopped')
 *   ready     no reply in time to the request at the  idle      kill the child, then fail(...). A late or
 *             head of the queue, a reply with the                misplaced reply would be handed to the
 *             wrong id, or a line that isn't JSON                wrong caller.
 *   any       stop()                                  idle      end stdin; reject the queue; no failure counted
 *
 *   A request made while starting or ready is written at once and joins the queue.
 *
 *   fail(reason): reject every request in the queue, failures++,
 *                 retryAt = now + RESTART_AFTER_MS[min(failures, last)], report(reason).
 *
 * So a crashed or hung helper costs the captures in flight (poll() turns each into
 * status 'error'), and a request after the pause starts a new one. A helper that can't
 * start at all (PowerShell locked down, say) is retried at most every 30 s instead of
 * in a loop.
 *
 * Stopping with the bridge needs no call. The helper exits when its stdin closes,
 * which Windows does for us however the bridge ends, including when Task Scheduler
 * kills it. The helper also watches the bridge's pid on a second thread, for the case
 * where it's stuck inside a Windows call and can't notice stdin.
 *
 * The child and its pipes never keep this process alive. While the helper is starting
 * or a request is in flight, the time limit on it does. So a command like
 * `t3code-wow install` that asked one question exits when it's done instead of
 * hanging on a helper nobody remembered to stop.
 */
export class Desktop {
  /** @type {import('node:child_process').ChildProcess|null} */
  #child = null;
  /** @type {'idle'|'starting'|'ready'} */
  #state = 'idle';
  /** @type {Array<{ id: number, timeoutMs: number, resolve: (f: Frame) => void, reject: (e: Error) => void }>} */
  #queue = [];
  #rest = Buffer.alloc(0);
  #stderr = '';
  /** The time limit on what the helper is doing now: starting, or answering the head of the queue. */
  #timer = null;
  #nextId = 1;
  #failures = 0;
  #retryAt = 0;
  #lastError = '';
  /** @type {{ pid: number|undefined, hwnd: number, at: number }|null} */
  #window = null;
  #launch;
  #timeoutMs;

  /**
   * Called with a plain-language message each time the helper fails to start or
   * stops. StripCapture points this at its log and its lastError, which is how
   * `t3code-wow status` can say why the game isn't being found.
   * @type {(message: string) => void}
   */
  report = () => {};

  /**
   * @param {{ launch?: () => import('node:child_process').ChildProcess, timeoutMs?: number }} [options]
   *   Both are for tests: `launch` starts a stand-in helper, and `timeoutMs` replaces
   *   every request's time limit so a test of a hung helper takes milliseconds.
   */
  constructor({ launch = launchHelper, timeoutMs } = {}) {
    this.#launch = launch;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Running programs with this image name (no ".exe").
   * @param {string} name
   * @returns {Promise<WinProcess[]>}
   */
  async processes(name) {
    // Measured at 6 ms. The limit only has to end before the bridge's next check, 4 s on.
    return (await this.#request('procs', { name }, 3000)).head.procs;
  }

  /**
   * The top-left corner of the game's client area, as StripCapture.grab() must return it.
   *
   * The client area starts exactly at the game's UI origin, so there's no title bar to
   * search past and no `searchY`. How the pixels are read is the helper's decision,
   * made per call:
   *  - 'screen': a copy of that rectangle of the screen. This is the normal path.
   *  - 'window': PrintWindow, which makes Windows render the whole client area. Used
   *    only while another window covers the corner or the corner is off screen, where
   *    a screen copy would read the wrong pixels. That keeps a command readable when
   *    the player sends it and switches straight to a browser.
   *
   * @param {number|undefined} pid  The client's pid from findWowProcess().
   * @param {{ width: number, height: number, region?: { x: number, y: number }|null }} options
   *   `region` is the config's capture.region: skip the window lookup and copy the
   *   screen at that point (physical pixels of the whole desktop).
   * @returns {Promise<GrabResult>}
   */
  async grab(pid, { width, height, region = null }) {
    const from = region ? { x: region.x, y: region.y } : { hwnd: await this.#gameWindow(pid) };
    if (from.hwnd === null) return { status: 'no-window' };
    const { head, data } = await this.#request('grab', { ...from, w: width, h: height }, 4000);
    if (head.state === 'ok') return { status: 'ok', image: { width: head.width, height: head.height, data }, via: head.via };
    // The game closed or made a new window: look again next time.
    if (head.state === 'gone') this.#window = null;
    return { status: head.state === 'gone' ? 'no-window' : 'hidden' };
  }

  /**
   * A JPEG of the game's whole client area for attaching to a message, at the size
   * the window has before display scaling, like the other platforms' screenshots.
   * Always PrintWindow: the whole window is wanted, once, and a window on top of the
   * game must not end up in the picture.
   * @param {number|undefined} pid
   * @returns {Promise<{ data: Buffer, mime: 'image/jpeg' }>}
   * @throws {Error} with the reason in plain words, which is shown in game.
   */
  async screenshot(pid) {
    const hwnd = await this.#gameWindow(pid);
    if (hwnd === null) throw new Error(NO_SHOT.gone);
    const { head, data } = await this.#request('shot', { hwnd, quality: 85 }, 8000);
    if (head.state !== 'ok') throw new Error(NO_SHOT[head.state]);
    return { data, mime: 'image/jpeg' };
  }

  /** Ask the helper to exit now. Only tests need this; see the class comment. */
  stop() {
    this.#child?.stdin.end();
    for (const waiting of this.#toIdle()) waiting.reject(new Error('the Windows helper was stopped'));
  }

  /**
   * The game's window handle, looked up at most every WINDOW_CACHE_MS, and again as
   * soon as a grab says the handle is gone.
   * @param {number|undefined} pid
   * @returns {Promise<number|null>}
   */
  async #gameWindow(pid) {
    const known = this.#window;
    if (known && known.pid === pid && Date.now() - known.at < WINDOW_CACHE_MS) return known.hwnd;
    const { head } = await this.#request('windows', { pid: pid || 0, title: 'World of Warcraft' }, 4000);
    const win = pickWinWindow(head.windows, pid);
    this.#window = win.found ? { pid, hwnd: win.hwnd, at: Date.now() } : null;
    return win.found ? win.hwnd : null;
  }

  /**
   * Write one request and wait for its reply. A reply with ok:false rejects with the
   * helper's message.
   * @param {string} op
   * @param {Record<string, string|number>} args
   * @param {number} timeoutMs  Counted from when the helper starts on this request.
   * @returns {Promise<Frame>}
   */
  #request(op, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.#state === 'idle' && Date.now() < this.#retryAt) return reject(new Error(this.#lastError));
      const id = this.#nextId++;
      this.#queue.push({ id, timeoutMs: this.#timeoutMs ?? timeoutMs, resolve, reject });
      if (this.#state === 'idle') this.#start();
      // A helper that couldn't be launched has failed the queue already.
      if (this.#state === 'idle') return;
      this.#child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      if (this.#state === 'ready' && this.#queue.length === 1) this.#limitHead();
    });
  }

  #start() {
    this.#state = 'starting';
    this.#rest = Buffer.alloc(0);
    this.#stderr = '';
    let child;
    try {
      child = this.#launch();
    } catch (err) {
      return this.#fail(`the bridge's Windows helper couldn't start: ${err.message}`);
    }
    this.#child = child;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) handle.unref();
    child.stdout.on('data', (chunk) => this.#read(child, chunk));
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(0, 2000);
    });
    // Writing to a helper that just died fails here. Its exit is what gets reported.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.#ended(child, err.message));
    child.on('close', (code) => this.#ended(child, `it exited with code ${code}`));
    this.#limit(READY_TIMEOUT_MS, `the bridge's Windows helper didn't start within ${READY_TIMEOUT_MS / 1000} s`);
  }

  #read(child, chunk) {
    if (child !== this.#child) return;
    let frames;
    try {
      ({ frames, rest: this.#rest } = splitFrames(Buffer.concat([this.#rest, chunk])));
    } catch {
      return this.#fail("the bridge's Windows helper sent something the bridge can't read");
    }
    for (const frame of frames) {
      if (this.#state === 'starting' && frame.head.ready) {
        this.#state = 'ready';
        this.#limitHead();
        continue;
      }
      const asked = this.#queue[0];
      if (this.#state !== 'ready' || frame.head.id !== asked?.id) {
        return this.#fail("the bridge's Windows helper sent a reply the bridge wasn't waiting for");
      }
      this.#queue.shift();
      this.#failures = 0;
      this.#limitHead();
      if (frame.head.ok) asked.resolve(frame);
      else asked.reject(new Error(frame.head.error));
    }
  }

  #ended(child, how) {
    if (child !== this.#child) return;
    const said = whatPowerShellSaid(this.#stderr) || how;
    this.#fail(this.#state === 'starting' ? `the bridge's Windows helper couldn't start: ${said}` : `the bridge's Windows helper stopped: ${said}`);
  }

  #limit(ms, reason) {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#fail(reason), ms);
  }

  #limitHead() {
    const head = this.#queue[0];
    if (head) this.#limit(head.timeoutMs, `the bridge's Windows helper didn't answer within ${head.timeoutMs / 1000} s`);
    else clearTimeout(this.#timer);
  }

  #fail(reason) {
    this.#child?.kill();
    const waiting = this.#toIdle();
    this.#failures++;
    this.#retryAt = Date.now() + RESTART_AFTER_MS[Math.min(this.#failures, RESTART_AFTER_MS.length - 1)];
    this.#lastError = reason;
    for (const request of waiting) request.reject(new Error(reason));
    this.report(reason);
  }

  /** Forget the child and hand back the requests it still owed. */
  #toIdle() {
    clearTimeout(this.#timer);
    const waiting = this.#queue;
    this.#queue = [];
    this.#child = null;
    this.#state = 'idle';
    return waiting;
  }
}

/**
 * The bridge's one helper. capture.js reads the strip and takes screenshots through
 * it, and wow.js asks it which programs are running. It starts on first use.
 */
export const desktop = new Desktop();
