import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// STATE_PATH is derived from homedir() at module evaluation, so point HOME at a
// scratch directory *before* the dynamic import below. Never touch a real ~/.dsh.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-redirect-'));
process.env.HOME = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
mkdirSync(join(scratchHome, '.dsh'), { recursive: true });

const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

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

/**
 * An MCP stub that lives at /mcp and answers `/mcp/` with a 308 to `/mcp`
 * (what Next.js/Vercel do for trailing-slash normalization). `crossOrigin`
 * points the redirect at another port instead, which must never be followed.
 */
function startStub({ crossOrigin = false } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    hits.push(`${req.method} ${path}`);
    if (path === '/mcp/') {
      const location = crossOrigin ? 'http://127.0.0.1:1/mcp' : '/mcp';
      res.writeHead(308, { Location: location, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ redirect: location, status: '308' }));
      return;
    }
    if (path !== '/mcp' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      if (payload.id === undefined) { res.writeHead(202); res.end(); return; }
      const result = payload.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'redirect-stub', version: '1' } }
        : payload.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] } : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        hits,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

it('follows a same-origin 308 from a trailing-slash URL and connects', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();
  try {
    const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'slash', type: 'http', url: `${stub.base}/mcp/`, authMode: 'none' });
    assert.equal(created.code, 201);
    const connected = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/connect`);
    assert.equal(connected.code, 200);
    assert.equal(connected.json.server.status, 'connected', connected.json.server.error);
    assert.equal(connected.json.server.toolCount, 1);
    assert.ok(stub.hits.includes('POST /mcp/') && stub.hits.includes('POST /mcp'), 'the redirect target must actually be requested');
  } finally {
    await stub.close();
  }
});

it('never follows a cross-origin 308', async () => {
  const stub = await startStub({ crossOrigin: true });
  const { handler } = makeCtx();
  try {
    const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'xorigin', type: 'http', url: `${stub.base}/mcp/`, authMode: 'none' });
    assert.equal(created.code, 201);
    const connected = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/connect`);
    assert.notEqual(connected.json.server.status, 'connected');
    assert.match(String(connected.json.server.error), /308/, 'the redirect response itself must surface as the error');
    assert.deepEqual([...new Set(stub.hits)], ['POST /mcp/'], 'only the configured URL may be requested');
  } finally {
    await stub.close();
  }
});
