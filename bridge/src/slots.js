// The inbound channel (bridge -> game).
//
// WoW addons can't read files at runtime, with two exceptions this relies on, both
// measured on live Forever clients (see docs/ARCHITECTURE.md):
//
//  * C_AddOns.LoadAddOn reads a load-on-demand addon's Lua from disk when it is
//    loaded. Each slot addon (T3Code_S001...) can be loaded once per UI session, and
//    /reload unloads them all. We write a snapshot into the next few slots the addon
//    will load.
//  * Sound files bigger than the client's cacheable size (Sound_MaxCacheableSizeInBytes,
//    174,762 bytes here) are streamed from disk and re-opened on every play (measured
//    on this client with inotify). So a large silent .wav is a reusable "bell": the
//    bridge fills it to announce a new snapshot, and the addon plays it and checks
//    C_Sound.IsPlaying a moment later (empty files never play). PlaySoundFile's own
//    "willPlay" answer is useless on Forever: it says true even for empty files.
//    Eight bells rotate so back-to-back updates can't be missed; they live at fixed
//    names inside the Signals folder that already existed when the client started.
//
// Files have to exist when the client starts: the game only indexes them at launch.

import fs from 'node:fs';
import path from 'node:path';
import { luaAssignment } from './luaser.js';

export const ADDON = 'T3Code';
export const INTERFACE = '16001';

export function slotName(i) {
  return `${ADDON}_S${String(i).padStart(3, '0')}`;
}

// Bells reuse signal files that were created at install time (the client only knows
// files that existed at launch) and were never raised, so they've never been cached.
export const BELL_BASE = 3991;
export const BELLS = 8;
export const CTL_LONG = 3999; // always a long valid sound: the addon's self-test
export const CTL_EMPTY = 4000; // always empty

export function sigName(k) {
  return String(k).padStart(5, '0') + '.wav';
}

// 10 s of 16-bit mono silence at 22.05 kHz: ~441 KB, comfortably over the cacheable
// size, so the client streams (and re-reads) it on every play.
export const LONG_SILENT_WAV = (() => {
  const data = 22050 * 2 * 10;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22050, 24);
  b.writeUInt32LE(22050 * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  return b;
})();

function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export class SlotBank {
  constructor(addonsDir, { slots = 600 } = {}) {
    this.addonsDir = addonsDir;
    this.slots = slots;
    this.sigDir = path.join(addonsDir, ADDON, 'Signals');
  }

  slotFile(i) {
    const name = slotName(i);
    return path.join(this.addonsDir, name, 'Inbox.lua');
  }

  sigFile(k) {
    return path.join(this.sigDir, sigName(k));
  }

  // Every slot's TOC is identical, and it loads Inbox.lua through a static Slot.xml.
  //
  // Addon managers (WowUp, the CurseForge app) identify folders by a 32-bit hash of the
  // .toc plus the files it lists, looked up against all of CurseForge. Inbox.lua changes
  // with every update, so listing it directly meant hundreds of fresh hashes per scan,
  // and one did collide (WowUp took a slot for a Minecraft modpack, and an "update"
  // would have replaced it). Their scanners follow only self-closing <Script file/>
  // tags, so with `<Script file="Inbox.lua"></Script>` every slot hashes the same two
  // unchanging files: one fixed fingerprint, checked against CurseForge once.
  //
  // No `## Dependencies` either: WowUp hides an unrecognised load-on-demand folder only
  // when all its dependencies are recognised, and T3Code isn't on its sites, so a
  // dependency on it listed every slot as an unknown addon. The game doesn't need it.
  slotToc() {
    return [
      `## Interface: ${INTERFACE}`,
      '## Title: T3 Code live update slot',
      '## Notes: Carries live updates from the T3 Code bridge. Leave it enabled.',
      '## Author: Ryan Hughes',
      '## LoadOnDemand: 1',
      `## Group: ${ADDON}`,
      '',
      'Slot.xml',
      '',
    ].join('\n');
  }

  slotXml() {
    return [
      '<Ui xmlns="http://www.blizzard.com/wow/ui/">',
      '\t<Script file="Inbox.lua"></Script>',
      '</Ui>',
      '',
    ].join('\n');
  }

  // Create every slot and bell that doesn't exist yet, refresh slot TOCs that differ,
  // and remove signal files older versions created but nothing uses. Returns counts.
  install() {
    let made = 0;
    let kept = 0;
    const ensure = (file, content, { refresh = false } = {}) => {
      if (fs.existsSync(file)) {
        if (refresh && fs.readFileSync(file, 'utf8') !== content) {
          fs.writeFileSync(file, content);
          made++;
        } else kept++;
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      made++;
    };
    for (let i = 1; i <= this.slots; i++) {
      const name = slotName(i);
      ensure(path.join(this.addonsDir, name, `${name}.toc`), this.slotToc(), { refresh: true });
      ensure(path.join(this.addonsDir, name, 'Slot.xml'), this.slotXml(), { refresh: true });
      ensure(this.slotFile(i), 'T3Code_Inbox = nil\n');
    }
    // Only the bells and the two self-test controls are ever played.
    for (let k = BELL_BASE; k < BELL_BASE + BELLS; k++) ensure(this.sigFile(k), '');
    ensure(this.sigFile(CTL_LONG), LONG_SILENT_WAV);
    ensure(this.sigFile(CTL_EMPTY), '');
    const keep = new Set([...Array(BELLS).keys()].map((i) => sigName(BELL_BASE + i)).concat(sigName(CTL_LONG), sigName(CTL_EMPTY)));
    let pruned = 0;
    try {
      for (const f of fs.readdirSync(this.sigDir)) {
        if (!keep.has(f)) {
          fs.rmSync(path.join(this.sigDir, f), { force: true });
          pruned++;
        }
      }
    } catch {}
    return { made, kept, pruned };
  }

  // Remove slot addons beyond `keep` (used by uninstall and when shrinking the bank).
  removeSlots(keep = 0) {
    let removed = 0;
    for (const d of fs.readdirSync(this.addonsDir)) {
      const m = /^T3Code_S(\d+)$/.exec(d);
      if (m && Number(m[1]) > keep) {
        fs.rmSync(path.join(this.addonsDir, d), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  installedSlotCount() {
    let n = 0;
    while (n < 10000 && fs.existsSync(this.slotFile(n + 1))) n++;
    return n;
  }

  write(slotIndexes, value) {
    const content = luaAssignment('T3Code_Inbox', value);
    for (const i of slotIndexes) {
      if (i < 1 || i > this.slots) continue;
      atomicWrite(this.slotFile(i), content);
    }
    return content.length;
  }

  bellFile(k) {
    return this.sigFile(BELL_BASE + ((((k - 1) % BELLS) + BELLS) % BELLS));
  }

  // Fill bell k and empty the one four behind it, so the addon's look-ahead window
  // (k .. k+3) only ever sees bells raised after it last loaded.
  raise(k) {
    atomicWrite(this.bellFile(k), LONG_SILENT_WAV);
    atomicWrite(this.bellFile(k - 4), '');
    return true;
  }

  // The self-test controls and empty bells; safe to call at every start.
  prepareBells() {
    const long = this.sigFile(CTL_LONG);
    try {
      if (fs.statSync(long).size !== LONG_SILENT_WAV.length) atomicWrite(long, LONG_SILENT_WAV);
    } catch {
      atomicWrite(long, LONG_SILENT_WAV);
    }
    atomicWrite(this.sigFile(CTL_EMPTY), '');
  }

  // Bells are re-read on every play, so at a client restart we only need them empty.
  resetSignals() {
    for (let i = 0; i < BELLS; i++) {
      try {
        atomicWrite(this.sigFile(BELL_BASE + i), '');
      } catch {}
    }
  }
}
