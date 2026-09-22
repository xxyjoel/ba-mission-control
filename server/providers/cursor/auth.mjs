// server/providers/cursor/auth.mjs — macOS keychain → dashboard session cookie.
//
// Reads the same cursor-access-token entry the Cursor CLI stores. The value is
// held only in memory for the caller; never logged or persisted.

import { execFileSync } from 'node:child_process';

const SECURITY = '/usr/bin/security';
const KEYCHAIN_ARGS = ['find-generic-password', '-a', 'cursor-user', '-s', 'cursor-access-token', '-w'];

/** JWT payload `sub` tail — matches scripts/probe-cursor.mjs usage scenario. */
export function jwtSubTail(accessToken) {
  if (typeof accessToken !== 'string' || !accessToken) return null;
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = payload?.sub;
    if (typeof sub !== 'string' || !sub) return null;
    return sub.includes('|') ? sub.split('|').pop() : sub;
  } catch {
    return null;
  }
}

/** WorkosCursorSessionToken cookie value (URL-encoded `subTail::token`). */
export function buildCursorSessionCookie(accessToken) {
  const tail = jwtSubTail(accessToken);
  if (!tail) return null;
  return encodeURIComponent(`${tail}::${accessToken}`);
}

/**
 * @param {{ execFileSync?: typeof execFileSync }} [opts]
 * @returns {string|null} cookie value for WorkosCursorSessionToken, or null
 */
export function getCursorSessionToken({ execFileSync: exec = execFileSync } = {}) {
  let raw;
  try {
    raw = exec(SECURITY, KEYCHAIN_ARGS, { encoding: 'utf8', timeout: 5000 });
  } catch {
    return null;
  }
  const token = String(raw ?? '').trim();
  if (!token) return null;
  return buildCursorSessionCookie(token);
}
