// The outbound channel (game -> bridge): screen-capture the top-left corner of the
// game window and decode the addon's pixel strip.
//
// Hyprland (and other wlroots compositors) allow screencopy, so `grim` can read the
// game's pixels on Wayland. X11 sessions use ImageMagick's `import`.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { decodeImage, parsePPM, CELLS_PER_ROW, MAX_ROWS } from './codec.js';

// A service may start before the session exports WAYLAND_DISPLAY; find the socket.
function captureEnv() {
  if (process.env.WAYLAND_DISPLAY) return process.env;
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  try {
    const sock = fs.readdirSync(runtime).find((f) => /^wayland-\d+$/.test(f));
    if (sock) return { ...process.env, XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: sock };
  } catch {}
  return process.env;
}

function run(cmd, args, { maxBuffer = 32 * 1024 * 1024, timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'buffer', maxBuffer, timeout, env: captureEnv() }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString();
        reject(err);
      } else resolve(stdout);
    });
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hyprland IPC (no hyprctl spawn needed)

function hyprSocket() {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const base = path.join(runtime, 'hypr');
  const sig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  if (sig && fs.existsSync(path.join(base, sig, '.socket.sock'))) return path.join(base, sig, '.socket.sock');
  // Running as a systemd service the variable may be missing: use the newest instance.
  try {
    const dirs = fs
      .readdirSync(base)
      .map((d) => path.join(base, d, '.socket.sock'))
      .filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return dirs[0] || null;
  } catch {
    return null;
  }
}

function hyprRequest(sock, cmd) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sock);
    const chunks = [];
    c.on('connect', () => c.write(cmd));
    c.on('data', (d) => chunks.push(d));
    c.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    c.on('error', reject);
    c.setTimeout(2000, () => {
      c.destroy();
      reject(new Error('hyprland ipc timeout'));
    });
  });
}

async function hyprWindow(pid) {
  const sock = hyprSocket();
  if (!sock) return null;
  const [clients, monitors] = await Promise.all([
    hyprRequest(sock, 'j/clients').then(JSON.parse),
    hyprRequest(sock, 'j/monitors').then(JSON.parse),
  ]);
  const win =
    clients.find((c) => pid && c.pid === pid) ||
    clients.find((c) => c.title === 'World of Warcraft') ||
    clients.find((c) => /^World of Warcraft/.test(c.title || ''));
  if (!win) return { found: false };
  const mon = monitors.find((m) => m.id === win.monitor) || monitors[0];
  const visible =
    !win.hidden &&
    mon &&
    (mon.activeWorkspace?.id === win.workspace?.id || mon.specialWorkspace?.id === win.workspace?.id);
  return {
    found: true,
    visible,
    x: win.at[0],
    y: win.at[1],
    width: win.size[0],
    height: win.size[1],
    scale: mon?.scale || 1,
    focused: undefined,
  };
}

// ---------------------------------------------------------------------------

export class StripCapture {
  constructor({ log = () => {}, backend = 'auto', region = null } = {}) {
    this.log = log;
    this.backend = backend;
    this.manualRegion = region; // { x, y, width, height } in compositor (logical) coordinates
    this.hint = null;
    this.lastError = null;
    this.lastSeenAt = 0;
    this.stats = { captures: 0, decoded: 0, rejected: 0, notVisible: 0 };
    this.lastImage = null;
  }

  resolveBackend() {
    if (this.backend !== 'auto') return this.backend;
    if (process.env.WAYLAND_DISPLAY || hyprSocket()) {
      if (hyprSocket() && which('grim')) return 'hyprland';
      if (which('grim')) return 'grim';
    }
    if (process.env.DISPLAY && which('import')) return 'x11';
    if (which('grim')) return 'grim';
    return 'none';
  }

  // Size of the region to grab, in physical pixels: the largest strip plus slack for
  // window borders and offset search.
  static stripPixels(cell = 4) {
    return { width: CELLS_PER_ROW * cell + 32, height: MAX_ROWS * cell + 32 };
  }

  async grab(wowPid) {
    const backend = this.resolveBackend();
    this.stats.captures++;
    if (backend === 'none') throw new Error('no capture backend: install grim (Wayland/wlroots) or ImageMagick (X11)');
    const px = StripCapture.stripPixels(4);
    if (backend === 'hyprland' || backend === 'grim') {
      let region = this.manualRegion;
      let scale = 1;
      if (!region && backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (!win?.found) return { status: 'no-window' };
        if (!win.visible) {
          this.stats.notVisible++;
          return { status: 'hidden' };
        }
        scale = win.scale;
        region = { x: win.x, y: win.y };
      }
      region = region || { x: 0, y: 0 };
      const w = Math.ceil(px.width / scale);
      const h = Math.ceil(px.height / scale);
      const buf = await run('grim', ['-g', `${region.x},${region.y} ${w}x${h}`, '-t', 'ppm', '-']);
      return { status: 'ok', image: parsePPM(buf) };
    }
    if (backend === 'x11') {
      const r = this.manualRegion || { x: 0, y: 0 };
      const buf = await run('import', [
        '-silent', '-window', 'root',
        '-crop', `${px.width}x${px.height}+${r.x}+${r.y}`,
        '-depth', '8', 'ppm:-',
      ]);
      return { status: 'ok', image: parsePPM(buf) };
    }
    throw new Error(`unknown capture backend ${backend}`);
  }

  // A screenshot of the game window for attaching to a message: JPEG at the
  // compositor's logical resolution (keeps it well under T3's 10 MB image limit).
  async screenshot(wowPid) {
    const backend = this.resolveBackend();
    const name = `wow-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
    if (backend === 'hyprland' || backend === 'grim') {
      const args = ['-t', 'jpeg', '-q', '85', '-s', '1'];
      if (backend === 'hyprland') {
        const win = await hyprWindow(wowPid);
        if (win?.found) args.push('-g', `${win.x},${win.y} ${win.width}x${win.height}`);
      }
      const data = await run('grim', [...args, '-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    if (backend === 'x11') {
      const data = await run('import', ['-silent', '-window', 'root', '-quality', '85', 'jpeg:-'], { timeout: 8000 });
      return { data, name, mime: 'image/jpeg' };
    }
    throw new Error('no screenshot backend (install grim)');
  }

  // One capture + decode. Returns { status, frame? }.
  async poll(wowPid) {
    let res;
    try {
      res = await this.grab(wowPid);
    } catch (err) {
      this.lastError = err.message;
      return { status: 'error', error: err.message };
    }
    if (res.status !== 'ok') return res;
    this.lastImage = res.image;
    const out = decodeImage(res.image, this.hint);
    if (!out) return { status: 'empty' };
    this.hint = out.geo;
    if (out.error) {
      this.stats.rejected++;
      return { status: 'rejected', error: out.error };
    }
    this.stats.decoded++;
    this.lastSeenAt = Date.now();
    return { status: 'frame', frame: out };
  }
}
