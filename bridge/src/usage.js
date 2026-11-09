// Provider usage for the Usage tab.
//
// T3 Code reports rate-limit windows per provider when it can read them. On Omarchy,
// the shell's Agents panel keeps a usage record per agent in
// ~/.local/state/omarchy/agents/usage/<id>.json (written by `omarchy-agent-usage-update`):
// plan tier, limits, today's activity, free reset credits and how to fix a lapsed
// sign-in. We read those same records, so the game shows exactly what the panel shows
// without asking the providers again. Only if they go stale (the panel isn't running)
// do we run the update ourselves, at most every 15 minutes. Without Omarchy the tab
// shows what T3 reports.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which } from './voice.js';

// T3 provider instance -> Omarchy usage id.
const OMARCHY_IDS = { codex: 'codex', claudeAgent: 'claude', claude: 'claude', grok: 'grok', opencode: 'opencode', cursor: 'cursor', antigravity: 'agy', pi: 'local' };
export const RECORDS_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'omarchy/agents/usage');
const STALE_MS = 20 * 60 * 1000;
const UPDATE_EVERY_MS = 15 * 60 * 1000;

function compactNumber(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

export class OmarchyUsage {
  constructor({ log = () => {}, onChange = () => {}, dir = RECORDS_DIR, updater = 'omarchy-agent-usage-update' } = {}) {
    this.log = log;
    this.onChange = onChange;
    this.dir = dir;
    this.updater = updater;
    this.records = new Map(); // omarchy id -> record
    this.seen = new Map(); // omarchy id -> mtimeMs we last read
    this.lastUpdateRun = 0;
    this.updating = false;
  }

  // Re-read the records for these T3 instance ids (cheap: only files that changed),
  // and run the updater if they're stale and nobody else is refreshing them.
  refresh(instanceIds) {
    let changed = false;
    let stale = false;
    for (const inst of instanceIds) {
      const id = OMARCHY_IDS[inst];
      if (!id) continue;
      const file = path.join(this.dir, `${id}.json`);
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        if (which(`omarchy-agent-usage-${id}`)) stale = true;
        continue;
      }
      if (Date.now() - st.mtimeMs > STALE_MS) stale = true;
      if (this.seen.get(id) === st.mtimeMs) continue;
      this.seen.set(id, st.mtimeMs);
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        const before = JSON.stringify(this.summary(this.records.get(id)));
        this.records.set(id, rec);
        if (JSON.stringify(this.summary(rec)) !== before) changed = true;
      } catch {}
    }
    if (changed) this.onChange();
    if (stale && !this.updating && Date.now() - this.lastUpdateRun > UPDATE_EVERY_MS && which(this.updater)) {
      this.updating = true;
      this.lastUpdateRun = Date.now();
      execFile(which(this.updater), [], { timeout: 120000 }, () => {
        this.updating = false;
        this.refresh(instanceIds);
      });
    }
  }

  // Only the fields we show, so unrelated churn doesn't count as a change.
  summary(rec) {
    if (!rec) return null;
    return {
      tier: rec.tierLabel || '',
      limits: (rec.limits || []).map((l) => [l.label, Math.round((l.percent || 0) * 100), l.resetsAt]),
      status: rec.usageStatusText || '',
      auth: rec.authHelpText || '',
      prompts: rec.todayPrompts || 0,
      tokens: Math.round((rec.todayTotalTokens || 0) / 1e6),
      credits: rec.resetCredits?.credits ?? rec.resetCredits ?? null,
    };
  }

  forInstance(inst) {
    const id = OMARCHY_IDS[inst];
    return id ? this.records.get(id) : null;
  }
}

// One provider's entry for the snapshot, merging T3's view with Omarchy's record.
export function mergeUsage(provider, rec, { escape = (s) => s, sec = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : undefined) } = {}) {
  const t3 = provider.usageLimits;
  let windows = (t3?.windows || []).map((w) => ({
    label: escape(w.label || w.kind),
    used: Math.round(w.usedPercent ?? 0),
    resets: sec(w.resetsAt),
  }));
  if (!windows.length && rec?.limits?.length) {
    windows = rec.limits.map((l) => ({
      label: escape(l.label || 'Limit'),
      used: Math.round((l.percent || 0) * 100),
      resets: sec(l.resetsAt),
    }));
  }
  let note;
  if (!windows.length) {
    if (rec && (rec.usageStatusText || rec.authHelpText)) {
      note = [rec.usageStatusText, rec.authHelpText].filter(Boolean).join(': ');
    } else if (t3?.unavailable) {
      note = t3.unavailable.message || (t3.unavailable.reason === 'unsupported' ? 'Usage limits are not available for this provider.' : 'Could not read usage right now.');
    } else {
      note = 'No usage limits reported.';
    }
  }
  const credits = rec?.resetCredits?.credits ?? (typeof rec?.resetCredits === 'number' ? rec.resetCredits : null);
  const today = rec && (rec.todayPrompts || rec.todayTotalTokens)
    ? `Today: ${rec.todayPrompts || 0} prompt${rec.todayPrompts === 1 ? '' : 's'} · ${compactNumber(rec.todayTotalTokens || 0)} tokens`
    : undefined;
  return {
    name: escape(provider.displayName || provider.instanceId),
    plan: escape(rec?.tierLabel || provider.plan?.label || provider.subscription?.label || '') || undefined,
    windows,
    note: note ? escape(note) : undefined,
    credits: Number.isFinite(credits) && credits > 0 ? credits : undefined,
    today: today ? escape(today) : undefined,
    checked: sec(t3?.checkedAt) || (rec?.updatedAt ? sec(rec.updatedAt) : undefined),
  };
}
