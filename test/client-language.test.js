import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// Run the real module factory with a tiny hook harness; no browser or dependencies.
function mount(fetch, navigator) {
  let exported, Section;
  let states = [], cursor = 0, effects = [], initialized = false;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = value; }];
    },
    useEffect: (effect) => { if (!initialized) effects.push(effect); },
    useCallback: (callback) => callback,
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => react); } } },
    fetch,
    ...(navigator === undefined ? {} : { navigator }),
  });
  exported.apply({ slots: { inject: (_name, cb) => cb(), register: (_spec, component) => { Section = component; } } });
  return {
    render(component = Section, props = {}) {
      cursor = 0;
      return component(props);
    },
    effects() { initialized = true; for (const effect of effects) effect(); effects = []; },
    reset() { states = []; },
  };
}
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function nodes(tree) {
  return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
}
const text = (tree) => typeof tree === 'string' ? tree : tree?.children?.map(text).join(' ') ?? '';
const selector = (tree) => nodes(tree).find((node) => node.type === 'select');
const content = (tree) => nodes(tree).find((node) => typeof node.type === 'function');

for (const [name, navigator, saved, expected] of [
  ['English browser', { language: 'en-US' }, null, 'en'],
  ['Chinese browser', { language: 'zh-CN' }, null, 'zh'],
  ['explicit Chinese overrides English browser', { language: 'en-US' }, 'zh', 'zh'],
  ['explicit English overrides Chinese browser', { language: 'zh-CN' }, 'en', 'en'],
  ['other locales use English', { language: 'fr-FR' }, null, 'en'],
  ['language takes precedence over languages', { language: 'en-US', languages: ['zh-CN'] }, null, 'en'],
  ['empty language uses languages fallback', { language: '', languages: ['en-GB'] }, null, 'en'],
  ['missing language uses languages fallback', { languages: ['zh-TW'] }, null, 'zh'],
  ['no navigator uses Chinese', undefined, null, 'zh'],
  ['empty locale uses Chinese', { language: '', languages: [] }, null, 'zh'],
]) {
  it(`renders the expected UI: ${name}`, async () => {
    const calls = [];
    const app = mount(async (url, options) => {
      calls.push([url, options]);
      return response({ language: saved });
    }, navigator);
    const initial = app.render();
    if (saved === null) assert.equal(selector(initial).props.value, expected);
    app.effects();
    await settle();
    const tree = app.render();
    assert.equal(selector(tree).props.value, expected);
    assert.match(text(tree), expected === 'en' ? /Language/ : /语言/);
    const body = content(tree);
    app.reset();
    assert.match(text(app.render(body.type, body.props)), expected === 'en' ? /MCP servers/ : /MCP 服务器/);
    assert.equal(calls.length, 1, 'automatic detection must not persist a choice');
    assert.equal(calls[0][0], '/mcp-manager/api/settings');
    assert.notEqual(calls[0][1]?.method, 'POST');
  });
}

it('renders settings load failures in the browser language', async () => {
  const app = mount(async () => response({}, false, 500), { language: 'en-US' });
  app.render(); app.effects(); await settle();
  assert.match(text(app.render()), /Could not load language \(HTTP 500\)/);
});

it('loads the saved language, switches through the API, and keeps the old choice on failure', async () => {
  const calls = [];
  let fail = false;
  const app = mount(async (url, options) => {
    calls.push([url, options]);
    return options?.method === 'POST'
      ? response(JSON.parse(options.body), !fail, fail ? 500 : 200)
      : response({ language: 'en' });
  });
  assert.equal(selector(app.render()).props.disabled, true);
  app.effects();
  await settle();
  let tree = app.render();
  assert.equal(selector(tree).props.value, 'en');
  assert.equal(content(tree).props.t('servers'), 'MCP servers');
  await selector(tree).props.onChange({ target: { value: 'zh' } });
  tree = app.render();
  assert.equal(content(tree).props.t('servers'), 'MCP 服务器');
  assert.equal(calls.at(-1)[0], '/mcp-manager/api/settings/language');
  assert.equal(calls.at(-1)[1].body, '{"language":"zh"}');
  fail = true;
  await selector(tree).props.onChange({ target: { value: 'en' } });
  tree = app.render();
  assert.equal(selector(tree).props.value, 'zh');
  assert.match(text(tree), /语言设置失败 \(HTTP 500\)/);
  assert.equal(selector(tree).props.disabled, false);
});

it('all translation keys have Chinese and English text, including interpolation', async () => {
  const table = runInNewContext('(' + source.match(/const STRINGS = (\{[\s\S]*?\n\t\t\});/)[1] + ')');
  assert.deepEqual(Object.keys(table.zh).sort(), Object.keys(table.en).sort());
  const translations = {};
  for (const language of ['zh', 'en']) {
    const app = mount(async () => response({ language }));
    app.render(); app.effects(); await settle();
    const t = content(app.render()).props.t;
    translations[language] = t;
    const keys = [...source.matchAll(/\bt\("([\w-]+)"/g)].map((match) => match[1]);
    for (const key of keys) assert.notEqual(t(key), key, `${language}: ${key}`);
    assert.equal(t('unknown-status'), 'unknown-status');
    assert.ok(t('confirmDelete', { name: '$& {name}' }).includes('$& {name}'));
  }
  assert.equal(translations.en('toolCount', { count: 2 }), 'Tools: 2');
  assert.equal(translations.zh('toolCount', { count: 2 }), '2 个工具');
  assert.equal(translations.en('needs-auth'), 'Authentication required');
  const afterTable = source.slice(source.indexOf('function translator'));
  assert.doesNotMatch(afterTable, /\p{Script=Han}/u, 'Chinese UI text must live in the table');
});

it('renders English list, add form, and stdio fields using the same translator', async () => {
  const app = mount(async () => response({ language: 'en' }));
  app.render(); app.effects(); await settle();
  const body = content(app.render());
  app.reset();
  let tree = app.render(body.type, body.props);
  assert.match(text(tree), /MCP servers/);
  nodes(tree).find((node) => node.props['aria-label'] === 'Add MCP server').props.onClick();
  tree = app.render(body.type, body.props);
  assert.match(text(tree), /Add MCP server/);
  const form = content(tree);
  app.reset();
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /Authentication method/);
  assert.match(text(tree), /Headers from environment variables/);
  nodes(tree).find((node) => node.type === 'select' && node.props.value === 'http').props.onChange({ target: { value: 'stdio' } });
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /Command \(executable\)/);
  assert.match(text(tree), /Environment variables/);
});
