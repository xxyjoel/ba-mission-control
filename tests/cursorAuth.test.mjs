import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jwtSubTail, buildCursorSessionCookie, getCursorSessionToken,
} from '../server/providers/cursor/auth.mjs';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

const ACCESS = 'eyJhbGciOiJub25lIn0.' + b64url({ sub: 'user|auth0|tail-user-99' }) + '.sig';
const RAW_TOKEN = `${ACCESS}`;

test('jwtSubTail: last segment after pipe, or whole sub', () => {
  assert.equal(jwtSubTail(ACCESS), 'tail-user-99');
  const noPipe = 'eyJhbGciOiJub25lIn0.' + b64url({ sub: 'plain-sub' }) + '.x';
  assert.equal(jwtSubTail(noPipe), 'plain-sub');
  assert.equal(jwtSubTail('not-a-jwt'), null);
  assert.equal(jwtSubTail(''), null);
});

test('buildCursorSessionCookie encodes subTail::token', () => {
  const cookie = buildCursorSessionCookie(ACCESS);
  assert.ok(cookie);
  assert.equal(decodeURIComponent(cookie), 'tail-user-99::' + ACCESS);
});

test('getCursorSessionToken: injectable exec returns shaped cookie', () => {
  const cookie = getCursorSessionToken({
    execFileSync: () => ACCESS + '\n',
  });
  assert.equal(cookie, buildCursorSessionCookie(ACCESS));
});

test('getCursorSessionToken: exec failure or bad jwt → null', () => {
  assert.equal(getCursorSessionToken({ execFileSync: () => { throw new Error('denied'); } }), null);
  assert.equal(getCursorSessionToken({ execFileSync: () => 'not-jwt' }), null);
  assert.equal(getCursorSessionToken({ execFileSync: () => '' }), null);
});
