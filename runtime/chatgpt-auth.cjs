'use strict';

// Independent Sign in with ChatGPT registration. Never reads or writes the
// user's Codex home, plugins, instructions, sessions, or refresh tokens.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => crypto.randomBytes(32).toString('base64url');
const present = value => typeof value === 'string' && value.length > 0;

function verifyIdentity(token, keys, { clientId, nonce, now = Date.now() }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT returned an invalid identity token');
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); }
  catch { throw new Error('ChatGPT returned an invalid identity token'); }
  if (header.alg !== 'RS256' || !present(header.kid) || !Array.isArray(keys.keys)) throw new Error('ChatGPT identity signature cannot be verified');
  const matches = keys.keys.filter(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (matches.length !== 1 || !crypto.verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')),
    crypto.createPublicKey({ key: matches[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) {
    throw new Error('ChatGPT identity signature cannot be verified');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (claims.iss !== ISSUER || !present(claims.sub) || !audience.includes(clientId)
    || !Number.isFinite(claims.exp) || claims.exp <= seconds || !Number.isFinite(claims.iat) || claims.iat > seconds + 60
    || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 60))
    || (nonce !== undefined && claims.nonce !== nonce)
    || (claims.azp !== undefined && claims.azp !== clientId) || (audience.length > 1 && claims.azp !== clientId)) {
    throw new Error('ChatGPT sign-in identity did not match this authorization');
  }
  return claims;
}

class ChatGPTAuth {
  constructor({ dataDir, fetch: request = globalThis.fetch, now = Date.now }) {
    this.request = request;
    this.now = now;
    this.file = path.join(dataDir, 'chatgpt-accounts.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [], activeId: null };
    if (this.state.version !== 1 || !present(this.state.hostId) || !Array.isArray(this.state.accounts)) throw new Error('Unrecognized ChatGPT account store');
    this.refreshes = new Map();
    this.save();
  }
  save() {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
  account() { return this.state.accounts.find(account => account.id === this.state.activeId); }
  status() {
    const account = this.account();
    return account?.tokens ? { kind: 'connected', accountId: account.id, email: account.email, name: account.name, clientId: account.clientId }
      : { kind: 'signed-out' };
  }
  accounts() { return this.state.accounts.map(({ id, email, name, clientId, tokens }) => ({ id, email, name, clientId, connected: !!tokens, active: id === this.state.activeId })); }
  async json(url, options = {}) {
    const response = await this.request(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30000) });
    let body;
    try { body = await response.json(); } catch { throw new Error(`ChatGPT authentication returned invalid data (HTTP ${response.status})`); }
    if (!response.ok) throw new Error(body?.error === 'invalid_grant' ? 'ChatGPT connection expired or was revoked. Sign in again.' : `ChatGPT authentication failed (HTTP ${response.status})`);
    return body;
  }
  async tokens(body, { clientId, nonce, previous }) {
    if (!present(body.access_token) || !present(body.refresh_token) || body.token_type?.toLowerCase() !== 'bearer'
      || !Number.isFinite(body.expires_in) || body.expires_in <= 0) throw new Error('ChatGPT did not return a complete renewable credential');
    const scope = body.scope === undefined ? previous?.tokens.scope : body.scope;
    if (typeof scope !== 'string' || !['resource.invoke', 'chatgpt.tokens.use.direct'].every(item => scope.split(/\s+/).includes(item))) {
      throw new Error('ChatGPT plan usage was not granted. Reconnect and allow plan usage.');
    }
    let identity;
    const idToken = body.id_token ?? previous?.tokens.id_token;
    if (body.id_token !== undefined || !previous) {
      if (!present(idToken)) throw new Error('ChatGPT did not return an identity token');
      identity = verifyIdentity(idToken, await this.json(ISSUER + '/.well-known/jwks.json'), { clientId, nonce, now: this.now() });
      if (previous && identity.sub !== previous.subject) throw new Error('ChatGPT account changed during token renewal');
    }
    return { subject: identity?.sub ?? previous.subject, email: identity?.email ?? previous?.email,
      name: identity?.name ?? previous?.name,
      tokens: { access_token: body.access_token, refresh_token: body.refresh_token, id_token: idToken, scope,
        expiresAt: this.now() + body.expires_in * 1000,
        ...(Number.isFinite(body.earliest_refresh_at) ? { earliestRefreshAt: body.earliest_refresh_at * 1000 } : {}) } };
  }
  async beginLogin({ openExternal, accountId, timeoutMs = 300000 }) {
    if (this.pending) throw new Error('A ChatGPT sign-in is already in progress');
    const previous = accountId === undefined ? undefined : this.state.accounts.find(account => account.id === accountId);
    if (accountId !== undefined && !previous) throw new Error('Unknown ChatGPT account');
    const state = random(), nonce = random(), verifier = random();
    let resolve, reject, timer, claimed = false;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Consumers receive the promise after the browser opens. Avoid an early
    // unhandled rejection if opening the browser itself fails.
    done.catch(() => {});
    const server = http.createServer((request, response) => {
      const callback = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || callback.pathname !== '/auth/callback') { response.writeHead(404).end(); return; }
      if (request.headers.host !== new URL(redirectUri).host || callback.searchParams.get('state') !== state) {
        response.writeHead(400).end('Invalid authorization state. Return to the app.'); return;
      }
      if (claimed) { response.writeHead(409).end('Authorization already received.'); return; }
      claimed = true;
      const finish = (error, result) => {
        response.writeHead(error ? 400 : 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
          .end(error ? 'ChatGPT sign-in failed. Return to the app and reconnect.' : 'ChatGPT connected. Return to Grok Bot Local.');
        close();
        error ? reject(error) : resolve(result);
      };
      (async () => {
        if (callback.searchParams.has('error')) throw new Error('ChatGPT authorization was declined or failed');
        const returnedClient = callback.searchParams.get('client_id');
        if (previous && returnedClient && returnedClient !== previous.clientId) throw new Error('ChatGPT returned a different account registration');
        const clientId = previous?.clientId ?? returnedClient;
        const code = callback.searchParams.get('code');
        if (!present(clientId) || clientId === 'dynamic_agent_client' || !present(code)) throw new Error('ChatGPT registration was incomplete');
        const body = await this.json(ISSUER + '/api/accounts/oauth/token', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }) });
        const credentials = await this.tokens(body, { clientId, nonce, previous });
        if (this.pending?.server !== server) throw new Error('ChatGPT sign-in was cancelled');
        const id = crypto.createHash('sha256').update(`${ISSUER}\0${clientId}\0${credentials.subject}`).digest('hex');
        const account = { id, clientId, ...credentials };
        this.state.accounts = this.state.accounts.filter(saved => saved.id !== id).concat(account);
        this.state.activeId = id;
        this.save();
        finish(null, this.status());
      })().catch(error => finish(error));
    });
    const close = () => { clearTimeout(timer); server.close(); if (this.pending?.server === server) this.pending = undefined; };
    this.pending = { server, cancel: () => { close(); reject(new Error('ChatGPT sign-in cancelled')); } };
    let redirectUri;
    try {
      await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
      redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(ISSUER + '/api/accounts/authorize');
      url.search = new URLSearchParams({ client_id: previous?.clientId ?? 'dynamic_agent_client',
        ...previous ? {} : { agent_name_hint: 'Grok Bot Local' }, ext_agent_host_id: this.state.hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE, state, nonce,
        code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        ...previous?.tokens?.id_token ? { id_token_hint: previous.tokens.id_token } : {},
        ...previous?.email ? { login_hint: previous.email } : {} });
      timer = setTimeout(() => { close(); reject(new Error('ChatGPT sign-in timed out')); }, timeoutMs);
      await openExternal(url.toString());
      return { done, cancel: () => this.pending?.cancel() };
    } catch (error) { close(); reject(error); throw error; }
  }
  cancelLogin() { this.pending?.cancel(); }
  async getAccessToken() {
    const account = this.account();
    if (!account?.tokens) throw new Error('Continue with ChatGPT to connect this app');
    if (account.tokens.expiresAt > this.now() + 60000) return account.tokens.access_token;
    if (account.tokens.earliestRefreshAt > this.now()) {
      if (account.tokens.expiresAt > this.now()) return account.tokens.access_token;
      throw new Error('ChatGPT token renewal is not available yet. Reconnect this account.');
    }
    if (!this.refreshes.has(account.id)) {
      const work = (async () => {
        const body = await this.json(ISSUER + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.tokens.refresh_token, resource: RESOURCE }) });
        const credentials = await this.tokens(body, { clientId: account.clientId, previous: account });
        if (!account.tokens) throw new Error('ChatGPT account was signed out during token renewal');
        Object.assign(account, credentials); this.save();
      })().finally(() => this.refreshes.delete(account.id));
      this.refreshes.set(account.id, work);
    }
    await this.refreshes.get(account.id);
    if (this.state.activeId !== account.id || !account.tokens) throw new Error('ChatGPT account changed during this request');
    return account.tokens.access_token;
  }
  async logout() {
    this.cancelLogin();
    const account = this.account();
    if (!account) return { revoked: true };
    this.state.activeId = null; this.save();
    // Finish an in-flight rotation before revoking its latest refresh token.
    await this.refreshes.get(account.id)?.catch(() => {});
    let revoked = !account.tokens;
    try {
      if (account.tokens) {
        const configuration = await this.json(ISSUER + '/.well-known/openid-configuration');
        if (configuration.issuer !== ISSUER || configuration.revocation_endpoint !== ISSUER + '/api/accounts/oauth/revoke') throw new Error('Unrecognized ChatGPT revocation endpoint');
        const response = await this.request(configuration.revocation_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: account.clientId, token_type_hint: 'refresh_token', token: account.tokens.refresh_token }) });
        revoked = response.status === 200;
      }
    } catch {}
    delete account.tokens; this.state.activeId = null; this.save();
    return { revoked };
  }
}

module.exports = { ChatGPTAuth, verifyIdentity };
