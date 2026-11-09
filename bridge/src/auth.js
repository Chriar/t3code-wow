// The bridge's T3 session token. Minted with the user's own `t3` CLI, stored 0600
// under ~/.config/t3code-wow, renewed a week before it expires.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 't3code-wow');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

const RENEW_BEFORE_MS = 7 * 24 * 3600 * 1000;

export function tokenClaims(token) {
  try {
    const [body] = token.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function findT3Cli() {
  const candidates = [
    process.env.T3_CLI,
    path.join(os.homedir(), '.local/bin/t3'),
    path.join(os.homedir(), '.t3/bin/t3'),
    '/usr/bin/t3',
    '/usr/local/bin/t3',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, 't3');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function mintToken({ label = 'WoW bridge' } = {}) {
  const cli = findT3Cli();
  if (!cli) return Promise.reject(new Error('could not find the `t3` command; open T3 Code once so it installs it'));
  const args = [
    'auth', 'session', 'issue',
    '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate',
    '--ttl', '30d',
    '--label', label,
    '--token-only',
  ];
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`t3 auth session issue failed: ${(stderr || err.message).trim()}`));
      const token = stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      if (!token || !tokenClaims(token)) return reject(new Error('t3 auth session issue printed no token'));
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
      resolve(token);
    });
  });
}

export function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Returns a function the T3 client calls before connecting.
export function tokenProvider({ log = () => {} } = {}) {
  let minting = null;
  let forceRenew = false;
  const provider = async () => {
    if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
    let token = readToken();
    const claims = token && tokenClaims(token);
    const expiring = !claims || (claims.exp && claims.exp - Date.now() < RENEW_BEFORE_MS);
    if (!token || expiring || forceRenew) {
      if (!minting) {
        log(token ? 'renewing the T3 session token' : 'minting a T3 session token');
        minting = mintToken().finally(() => {
          minting = null;
          forceRenew = false;
        });
      }
      try {
        token = await minting;
      } catch (err) {
        if (!token) throw err;
        log(`token renewal failed, using the old one: ${err.message}`);
      }
    }
    return token;
  };
  provider.invalidate = () => {
    forceRenew = true;
  };
  return provider;
}
