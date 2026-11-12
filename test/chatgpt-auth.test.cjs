'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatGPTAuth, verifyIdentity } = require('../runtime/chatgpt-auth.cjs');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' }] };
function jwt(claims) {
  const content = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  return content + '.' + crypto.sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
}

test('independent registration, PKCE, identity validation, model token and serialized refresh', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-chatgpt-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let time = Date.now(), authorization, exchanges = 0, refreshes = 0;
  const request = async (url, options) => {
    if (url.endsWith('/.well-known/jwks.json')) return Response.json(keys);
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('client_id'), 'fixture-client');
    assert.equal(form.get('resource'), 'https://api.openai.com/v1');
    if (form.get('grant_type') === 'authorization_code') {
      exchanges++;
      assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.equal(crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expires_in: 3600,
        scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct',
        id_token: jwt({ iss: 'https://auth.openai.com', aud: 'fixture-client', sub: 'test-user', email: 'fixture@example.test',
          nonce: authorization.searchParams.get('nonce'), iat: Math.floor(time / 1000), exp: Math.floor(time / 1000) + 3600 }) });
    }
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'test-refresh');
    refreshes++;
    await new Promise(resolve => setImmediate(resolve));
    return Response.json({ access_token: 'renewed-access', refresh_token: 'renewed-refresh', token_type: 'Bearer', expires_in: 3600 });
  };
  const auth = new ChatGPTAuth({ dataDir, fetch: request, now: () => time });
  const hostId = auth.state.hostId;
  assert.equal(auth.status().kind, 'signed-out');
  const login = await auth.beginLogin({ openExternal: async url => { authorization = new URL(url); } });
  t.after(() => auth.cancelLogin());
  assert.equal(authorization.origin + authorization.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'Grok Bot Local');
  assert.equal(authorization.searchParams.get('ext_agent_host_id'), hostId);
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: 'invalid', code: 'test-code', client_id: 'fixture-client' });
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  assert.equal((await fetch(callback)).status, 200);
  assert.equal((await login.done).kind, 'connected');
  assert.equal(exchanges, 1);
  assert.equal(await auth.getAccessToken(), 'test-access');
  assert.equal(fs.statSync(auth.file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(auth.status()).includes('test-access'));
  assert.ok(!JSON.stringify(auth.accounts()).includes('test-refresh'));
  time += 3600000;
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ['renewed-access', 'renewed-access']);
  assert.equal(refreshes, 1);
  const reopened = new ChatGPTAuth({ dataDir, fetch: request, now: () => time });
  assert.equal(reopened.state.hostId, hostId);
  assert.equal(await reopened.getAccessToken(), 'renewed-access');
  const returning = await reopened.beginLogin({ accountId: reopened.status().accountId, openExternal: async url => { authorization = new URL(url); } });
  assert.equal(authorization.searchParams.get('client_id'), 'fixture-client');
  assert.equal(authorization.searchParams.has('agent_name_hint'), false);
  returning.cancel();
  await assert.rejects(returning.done, /cancelled/);
});

test('OIDC checks signature, audience, nonce, subject, expiry and authorized party', () => {
  const now = Date.now(), seconds = Math.floor(now / 1000);
  const good = { iss: 'https://auth.openai.com', aud: 'fixture-client', sub: 'fixture-user', iat: seconds, exp: seconds + 3600, nonce: 'expected' };
  const options = { clientId: 'fixture-client', nonce: 'expected', now };
  assert.equal(verifyIdentity(jwt(good), keys, options).sub, 'fixture-user');
  for (const change of [{ iss: 'https://example.test' }, { aud: 'other' }, { nonce: 'wrong' }, { sub: '' }, { exp: seconds - 1 }, { aud: ['fixture-client', 'other'] }, { azp: 'other' }]) {
    assert.throws(() => verifyIdentity(jwt({ ...good, ...change }), keys, options));
  }
  const token = jwt(good).split('.');
  token[1] = Buffer.from(JSON.stringify({ ...good, sub: 'altered' })).toString('base64url');
  assert.throws(() => verifyIdentity(token.join('.'), keys, options), /signature/);
});

test('declined authorization never exchanges a code or replaces an active account', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-chatgpt-declined-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let authorization;
  const auth = new ChatGPTAuth({ dataDir, fetch: async () => { assert.fail('No token exchange on refusal'); } });
  const login = await auth.beginLogin({ openExternal: async url => { authorization = new URL(url); } });
  const callback = new URL(authorization.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: authorization.searchParams.get('state'), error: 'access_denied' });
  assert.equal((await fetch(callback)).status, 400);
  await assert.rejects(login.done, /declined/);
  assert.equal(auth.status().kind, 'signed-out');
  assert.equal(auth.state.accounts.length, 0);
});
