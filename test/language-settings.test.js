import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-language-'));
process.env.HOME = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx() {
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    // The plugin injects `webServer` lazily (it is optional), so hand the
    // callback a child ctx exposing the stubbed webserver.
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
  return { routes, disposers };
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


it('language defaults to Chinese, validates input, and persists across apply() restarts', async () => {
  const handler = makeCtx().routes[0].handler;
  const get = (h = handler) => request(h, 'GET', '/mcp-manager/api/settings');
  const post = (body) => request(handler, 'POST', '/mcp-manager/api/settings/language', body);
  assert.equal((await get()).json.language, 'zh');
  for (const body of [{}, null, { language: 'fr' }, { language: 1 }, { language: 'EN' }]) {
    assert.equal((await post(body)).code, 400);
  }
  assert.equal((await get()).json.language, 'zh');
  assert.equal((await post({ language: 'en' })).code, 200);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).language, 'en');
  assert.equal((await get(makeCtx().routes[0].handler)).json.language, 'en');
  assert.equal((await request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true })).code, 200);
  assert.equal((await get()).json.language, 'en');
  assert.equal((await post({ language: 'zh' })).code, 200);
  const settings = (await get(makeCtx().routes[0].handler)).json;
  assert.equal(settings.language, 'zh');
  assert.equal(settings.onDemandToolInjection, true);
});
