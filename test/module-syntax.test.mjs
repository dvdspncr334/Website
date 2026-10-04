// Regression guard: every module in the production admin import graph must parse
// as an ES module. A single syntax error (for example an unterminated template
// literal) stops admin.html at "Checking admin access…". This file does not
// import the modules statically so a broken file is reported here by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const LOCAL_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\/[^'"]+\.js)['"]/g;

function inlineModules(html) {
  return [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(match => match[1]);
}

function importGraph(sources) {
  const seen = new Set();
  const queue = sources.flatMap(source => [...source.matchAll(LOCAL_IMPORT)].map(match => match[1].slice(2)));
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...[...read(file).matchAll(LOCAL_IMPORT)].map(match => match[1].slice(2)));
  }
  return [...seen].sort();
}

function checkModule(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
  return { ok: result.status === 0, error: result.stderr };
}

const adminInline = inlineModules(read('admin.html'));
const adminGraph = importGraph(adminInline);

test('admin import graph includes the order UI and its dependencies', () => {
  assert.equal(adminInline.length, 1);
  for (const file of ['admin-auth.js', 'admin-order-ui.js', 'admin-orders.js', 'admin-tools.js', 'account-data.js', 'auth-firebase.js']) {
    assert.ok(adminGraph.includes(file), `${file} is reachable from admin.html`);
  }
});

test('admin.html inline module and every imported local module parse as ES modules', () => {
  const inline = checkModule(adminInline[0]);
  assert.ok(inline.ok, `admin.html inline module:\n${inline.error}`);
  for (const file of adminGraph) {
    const result = checkModule(read(file));
    assert.ok(result.ok, `${file} is not a valid ES module:\n${result.error}`);
  }
});

test('admin modules contain no display-truncation artifacts', () => {
  for (const file of ['admin.html', ...adminGraph]) {
    const lines = read(file).split('\n');
    const bad = lines.flatMap((line, index) => /\[\.\.\.\]|\[…\]/.test(line) ? [`${file}:${index + 1}`] : []);
    assert.deepEqual(bad, [], 'truncated preview text was saved into source');
  }
});

test('the syntax guard rejects an unterminated template literal like the broken admin build', () => {
  const broken = "const a = true\n  ? `New arrivals ar[...]\n  : `Cancel exactly ${x}.`;\nexport default a;\n";
  assert.equal(checkModule(broken).ok, false);
  assert.equal(checkModule('export const ok = `fine`;\n').ok, true);
});
