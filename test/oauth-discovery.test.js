import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// STATE_PATH is derived from homedir() at module evaluation, so point HOME at a
// scratch directory *before* the dynamic import below. Never touch a real ~/.dsh.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-oauth-disc-'));
process.env.HOME = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');

const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx() {
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({
          webServer: ctx.webServer,
          get: () => undefined,
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
        });
      }
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  apply(ctx);
  return { handler: routes[0]?.handler };
}

/** Call the mounted route with a minimal req/res pair. */
async function request(handler, method, path, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ?? ''; },
  };
  await handler(req, res);
  return { code: res.code, json: res.body ? JSON.parse(res.body) : undefined };
}

/** Serve a route table; record every (method, path) the plugin touches. */
function startStub(routesFor) {
  const hits = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    hits.push(`${req.method} ${path}`);
    const route = routesFor(server)[`${req.method} ${path}`];
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>next.js 404</body></html>');
      return;
    }
    const [status, headers, body] = route;
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        hits,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

/**
 * Mobbin-shaped provider: the MCP endpoint is on one host, the authorization
 * server lives elsewhere under a path prefix (Supabase Auth style
 * `https://<ref>.supabase.co/auth/v1`), and nothing is served at the
 * root-level well-known locations or at a guessed `/register`.
 */
function separateAuthServerRoutes(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const issuer = `${base}/auth/v1`;
  const json = { 'Content-Type': 'application/json' };
  const challenge = { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, ...json };
  const unauthorized = [401, challenge, { error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' } }];
  return {
    'POST /mcp': unauthorized,
    'POST /mcp/': unauthorized,
    'GET /.well-known/oauth-protected-resource/mcp': [200, json, { resource: `${base}/mcp`, authorization_servers: [issuer], scopes_supported: ['openid'] }],
    // RFC 8414 path-insertion form for an issuer that carries a path.
    'GET /.well-known/oauth-authorization-server/auth/v1': [200, json, {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/clients/register`,
    }],
    'POST /auth/v1/oauth/clients/register': [201, json, { client_id: 'cid-from-auth-server', token_endpoint_auth_method: 'none' }],
  };
}

it('follows WWW-Authenticate → protected-resource metadata → authorization server for registration', async () => {
  const stub = await startStub(separateAuthServerRoutes);
  const { handler } = makeCtx();
  try {
    // Trailing slash on purpose: that is how users often paste the URL.
    const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'mobbin-like', type: 'http', url: `${stub.base}/mcp/`, authMode: 'oauth' });
    assert.equal(created.code, 201);
    assert.equal(created.json.server.status, 'needs-auth');

    const started = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/auth`);
    assert.equal(started.code, 200, JSON.stringify(started.json));
    const authorize = new URL(started.json.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${stub.base}/auth/v1/oauth/authorize`, 'authorize URL must come from the discovered authorization server');
    assert.equal(authorize.searchParams.get('client_id'), 'cid-from-auth-server');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), 'openid', 'scopes advertised by the protected resource are requested');
    assert.equal(authorize.searchParams.get('redirect_uri'), `http://127.0.0.1:3080/mcp-manager/callback/${created.json.server.id}`);

    assert.ok(stub.hits.includes('POST /auth/v1/oauth/clients/register'), 'registration must hit the advertised registration_endpoint');
    assert.ok(!stub.hits.includes('POST /register'), 'registration must not be guessed at <origin>/register');
    assert.ok(!stub.hits.includes('POST /auth/v1/register'), 'registration must not be guessed at <issuer>/register');

    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(persisted.servers.find((server) => server.name === 'mobbin-like').oauth.clientId, 'cid-from-auth-server');
  } finally {
    await stub.close();
  }
});

/**
 * Legacy-shaped provider: the MCP origin is its own authorization server and
 * publishes root-level RFC 8414 metadata (no resource_metadata hint). This is
 * the path every pre-0.12.1 install relied on; it must keep working unchanged.
 */
function selfHostedRoutes(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  return {
    'POST /mcp': [401, json, { error: 'unauthorized' }],
    'GET /.well-known/oauth-authorization-server': [200, json, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize/`,
      token_endpoint: `${base}/oauth/token/`,
      registration_endpoint: `${base}/oauth/register/`,
    }],
    'POST /oauth/register/': [201, json, { client_id: 'cid-self-hosted' }],
  };
}

it('still uses root-level authorization-server metadata on the MCP origin when present', async () => {
  const stub = await startStub(selfHostedRoutes);
  const { handler } = makeCtx();
  try {
    const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'self-hosted', type: 'http', url: `${stub.base}/mcp`, authMode: 'oauth' });
    assert.equal(created.code, 201);
    const started = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/auth`);
    assert.equal(started.code, 200, JSON.stringify(started.json));
    const authorize = new URL(started.json.authorizeUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${stub.base}/oauth/authorize/`);
    assert.equal(authorize.searchParams.get('client_id'), 'cid-self-hosted');
    assert.equal(authorize.searchParams.get('scope'), null, 'no scope is invented when the resource advertises none');
    assert.ok(!stub.hits.some((hit) => hit.startsWith('GET /.well-known/oauth-protected-resource')), 'resource metadata is only consulted when the origin has no metadata of its own');
  } finally {
    await stub.close();
  }
});
