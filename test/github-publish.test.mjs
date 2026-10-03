import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishShop, PUBLISH_LIMITS } from '../github-publish.js';

const sha = n => n.toString(16).padStart(40, '0');
const HEAD = sha(1);
const BASE_TREE = sha(2);
const BASE_CSV = sha(3);
const PHOTO = sha(4);
const CSV = sha(5);
const TREE = sha(6);
const COMMIT = sha(7);
const TOKEN = 'private-test-credential';
const photo = (path = 'images/products/test-body/front-123.png', size = 3, type = 'image/png') => ({
  path, blob: new Blob([new Uint8Array(size)], { type })
});
const options = overrides => ({
  owner: 'test-owner', repo: 'Website', branch: 'main', token: TOKEN,
  message: 'Update shop', csv: 'id,title\nbody,Café\n', baseSha: BASE_CSV,
  photos: [photo()], ...overrides
});
const response = (data, status = 200, extra = {}) => ({
  ok: status >= 200 && status < 300, status, redirected: false, url: '',
  json: async () => data, ...extra
});
const ref = (id = HEAD, branch = 'main') => ({
  ref: `refs/heads/${branch}`, object: { type: 'commit', sha: id }
});
const entry = (path, type = 'blob', mode = '100644', id = sha(20)) => ({
  path, type, mode, sha: id
});

function mock({ intercept, entries = [], branch = 'main' } = {}) {
  const calls = [];
  let blobPosts = 0;
  const fetchImpl = async (url, init) => {
    const call = {
      url, ...init, body: init.body === undefined ? undefined : JSON.parse(init.body)
    };
    calls.push(call);
    if (intercept) {
      const override = await intercept(call, calls);
      if (override !== undefined) return override;
    }
    const path = new URL(url).pathname;
    if (init.method === 'PATCH') return response(ref(COMMIT, branch));
    if (init.method === 'POST') {
      if (path.endsWith('/blobs')) {
        blobPosts++;
        return response({ sha: call.body.encoding === 'utf-8' ? CSV : (blobPosts === 1 ? PHOTO : sha(30 + blobPosts)) }, 201);
      }
      if (path.endsWith('/trees')) return response({ sha: TREE }, 201);
      if (path.endsWith('/commits')) return response({ sha: COMMIT }, 201);
    }
    if (path.includes('/git/ref/')) return response(ref(HEAD, branch));
    if (path.includes('/git/commits/')) return response({ sha: HEAD, tree: { sha: BASE_TREE } });
    if (path.includes('/git/trees/')) {
      return response({
        sha: BASE_TREE, truncated: false,
        tree: [entry('data', 'tree', '040000'), entry('data/shop.csv', 'blob', '100644', BASE_CSV), ...entries]
      });
    }
    if (path.includes('/git/blobs/')) {
      return response({ sha: BASE_CSV, encoding: 'base64', size: 4, content: 'aWQK' });
    }
    assert.fail(`Unexpected endpoint: ${url}`);
  };
  return { fetchImpl, calls };
}

const patches = calls => calls.filter(call => call.method === 'PATCH');
const writes = calls => calls.filter(call => call.method !== 'GET');

test('exports immutable upload limits for UI validation', () => {
  assert.deepEqual(PUBLISH_LIMITS, {
    maxPhotos: 20, maxPhotoBytes: 10 * 1024 * 1024,
    maxTotalBytes: 40 * 1024 * 1024, maxCsvBytes: 2 * 1024 * 1024
  });
  assert.equal(Object.isFrozen(PUBLISH_LIMITS), true);
});

test('publishes photos and UTF-8 CSV atomically, preserving the base tree', async () => {
  const states = [];
  let confirm;
  const confirmed = new Promise(resolve => { confirm = resolve; });
  const api = mock({
    entries: [entry('unrelated.txt'), entry('images', 'tree', '040000')],
    intercept: async call => {
      if (call.method === 'PATCH') {
        assert.deepEqual(states.map(([, state]) => state), ['pending', 'pending']);
        await confirmed;
      }
    }
  });
  let finished = false;
  const photos = [photo(), photo('images/products/test-body/back_123.webp', 3, 'image/webp')];
  const result = publishShop(options({ photos, onPhotoState: (path, state) => states.push([path, state]) }), api.fetchImpl);
  result.then(() => { finished = true; });
  while (!patches(api.calls).length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(states.some(([, state]) => state === 'completed'), false);
  confirm();
  assert.deepEqual(await result, { csvSha: CSV, commitSha: COMMIT });
  const posts = writes(api.calls);
  assert.equal(posts.length, 6);
  assert.deepEqual(posts[0].body, { content: 'AAAA', encoding: 'base64' });
  assert.deepEqual(posts[2].body, { content: options().csv, encoding: 'utf-8' });
  assert.deepEqual(posts[3].body, {
    base_tree: BASE_TREE,
    tree: [
      { path: photos[0].path, type: 'blob', mode: '100644', sha: PHOTO },
      { path: photos[1].path, type: 'blob', mode: '100644', sha: sha(32) },
      { path: 'data/shop.csv', type: 'blob', mode: '100644', sha: CSV }
    ]
  });
  assert.deepEqual(posts[4].body, { message: 'Update shop', tree: TREE, parents: [HEAD] });
  assert.deepEqual(posts[5].body, { sha: COMMIT, force: false });
  assert.deepEqual(states, [
    ...photos.map(file => [file.path, 'pending']),
    ...photos.map(file => [file.path, 'completed'])
  ]);
  assert.equal(api.calls.filter(call => call.url.includes('/git/blobs/')).length, 2);
  for (const call of api.calls) {
    assert.equal(new URL(call.url).origin, 'https://api.github.com');
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.headers.Authorization, ['Bearer', TOKEN].join(' '));
    assert.equal(call.url.includes(TOKEN), false);
    assert.equal(JSON.stringify(call.body)?.includes(TOKEN) ?? false, false);
  }
});

test('CSV-only publication and a slash-separated branch work without photo callbacks', async () => {
  const api = mock({ branch: 'release/shop-v2' });
  await publishShop(options({ branch: 'release/shop-v2', photos: [] }), api.fetchImpl);
  assert.equal(writes(api.calls).length, 4);
  assert.match(patches(api.calls)[0].url, /git\/refs\/heads\/release\/shop-v2$/);
});

test('accepts valid schema product IDs with repeated or trailing dashes', async () => {
  const files = [
    photo('images/products/body--red/front.png'),
    photo('images/products/body-/back.png'),
    photo('images/products/a---/front.png')
  ];
  const api = mock();
  await publishShop(options({ photos: files }), api.fetchImpl);
  const tree = writes(api.calls).find(call => call.url.endsWith('/trees')).body.tree;
  assert.deepEqual(tree.slice(0, 3).map(item => item.path), files.map(file => file.path));
  assert.equal(patches(api.calls).length, 1);
});

for (const [field, values] of [
  ['owner', ['', 'a/b', 'a%2Fb', '..', '-owner', 'owner-', 'x'.repeat(40), 'https://evil.test']],
  ['repo', ['', '../repo', 'repo/name', 'repo?x', 'repo#x', 'repo\\name', 'x'.repeat(101)]],
  ['branch', ['', '/main', 'main/', 'a//b', 'a/../b', 'a/.hidden', 'a.lock', 'a.lock/b',
    'main.', '-main', 'a..b', 'a@{b', 'a b', 'a%2Fb', 'a?b', 'refs:main', 'x'.repeat(256)]],
  ['token', ['', null, 'bad\nheader', 'bad token']],
  ['baseSha', ['', null, 'main', 'a'.repeat(39), 'A'.repeat(40)]],
  ['message', ['', ' ', null, 'x'.repeat(10001)]],
  ['csv', [null, {}, 'é'.repeat(1024 * 1024 + 1)]],
  ['photos', [null, {}, Array.from({ length: 21 }, () => photo())]]
]) {
  test(`rejects invalid ${field} before networking`, async () => {
    for (const value of values) {
      const api = mock();
      await assert.rejects(publishShop(options({ [field]: value }), api.fetchImpl));
      assert.equal(api.calls.length, 0);
    }
  });
}

test('rejects traversal, encoded, uppercase, unsafe, and duplicate generated paths', async () => {
  for (const path of [
    'images/products/a/../x.png', '/images/products/a/x.png',
    'images/products/a/x.PNG', 'images/products/A/x.png', 'images/products/a/x.svg',
    'images/products/a/x.gif',
    'images/products/a/x%20.png', 'images/products/a/x?.png', 'images/products/a/.x.png',
    'images/products/a/x.y.png', 'images/products/a/x\\y.png', 'images/products/a/x.png/extra',
    'images/products/-a/x.png',
    'images/products/a/' + 'x'.repeat(240) + '.png'
  ]) {
    const api = mock();
    await assert.rejects(publishShop(options({ photos: [photo(path)] }), api.fetchImpl));
    assert.equal(api.calls.length, 0);
  }
  const api = mock();
  await assert.rejects(publishShop(options({ photos: [photo(), photo()] }), api.fetchImpl));
  assert.equal(api.calls.length, 0);
});

test('rejects empty, oversized, mismatched MIME and non-Blob photos', async () => {
  for (const file of [
    photo(undefined, 0), photo(undefined, 10 * 1024 * 1024 + 1),
    photo(undefined, 1, 'image/jpeg'), photo(undefined, 1, 'image/svg+xml'),
    photo(undefined, 1, 'image/gif'),
    photo(undefined, 1, ''), { ...photo(), blob: { size: 1, type: 'image/png' } }
  ]) {
    const api = mock();
    await assert.rejects(publishShop(options({ photos: [file] }), api.fetchImpl));
    assert.equal(api.calls.length, 0);
  }
});

test('enforces 40 MB aggregate including CSV; accepts 20 photos and bounded UTF-8 CSV', async () => {
  const photos = Array.from({ length: 4 }, (_, i) =>
    photo(`images/products/a/${i}.png`, 10 * 1024 * 1024));
  const api = mock();
  await assert.rejects(publishShop(options({ photos }), api.fetchImpl), /combined upload/);
  assert.equal(api.calls.length, 0);
  const allowed = mock();
  await publishShop(options({
    photos: Array.from({ length: 20 }, (_, i) => photo(`images/products/a/${i}.png`)),
    csv: 'é'.repeat(1024 * 1024)
  }), allowed.fetchImpl);
  assert.equal(writes(allowed.calls).filter(call => call.url.endsWith('/blobs')).length, 21);
});

for (const status of [401, 403, 404, 409, 422, 500]) {
  test(`safe HTTP ${status} errors never echo server credentials`, async () => {
    const api = mock({ intercept: () => response({ message: TOKEN }, status) });
    await assert.rejects(publishShop(options(), api.fetchImpl), error =>
      !error.message.includes(TOKEN) && /Keep your drafts|keep your drafts/.test(error.message));
    assert.equal(patches(api.calls).length, 0);
  });
}

test('network errors are sanitized, without a cause or credential echo', async () => {
  const api = mock({ intercept: () => { throw new Error(TOKEN); } });
  await assert.rejects(publishShop(options(), api.fetchImpl), error =>
    error.code === 'network' && !error.message.includes(TOKEN) && !error.cause);
  assert.equal(writes(api.calls).length, 0);
});

test('early baseline, permission, network and cancellation failures mark every staged photo failed', async () => {
  const files = [photo(), photo('images/products/test-body/back.png')];
  for (const config of [
    { intercept: () => response({}, 403) },
    { intercept: () => { throw new Error(TOKEN); } },
    { intercept: call => call.url.includes('/git/trees/') ?
      response({ sha: BASE_TREE, truncated: true, tree: [] }) : undefined },
    { intercept: call => call.url.includes('/git/trees/') ?
      response({ sha: BASE_TREE, truncated: false, tree: [] }) : undefined }
  ]) {
    const states = [];
    const api = mock(config);
    await assert.rejects(publishShop(options({
      photos: files, onPhotoState: (path, state) => states.push([path, state])
    }), api.fetchImpl));
    assert.deepEqual(states, files.map(file => [file.path, 'failed']));
    assert.equal(writes(api.calls).length, 0);
  }
  for (const override of [
    { isCurrent: () => false }, { photos: [photo(undefined, 0)] }
  ]) {
    const states = [];
    const api = mock();
    const args = options({ ...override, onPhotoState: (path, state) => states.push([path, state]) });
    await assert.rejects(publishShop(args, api.fetchImpl));
    assert.deepEqual(states, args.photos.map(file => [file.path, 'failed']));
    assert.equal(api.calls.length, 0);
  }
});

for (const extra of [
  { status: 302, ok: false }, { redirected: true },
  { url: 'https://evil.example/result' }, { url: 'http://api.github.com/result' }
]) {
  test(`rejects redirects or foreign response origins ${JSON.stringify(extra)}`, async () => {
    const api = mock({ intercept: () => response({}, 200, extra) });
    await assert.rejects(publishShop(options(), api.fetchImpl), { code: 'redirect' });
    assert.equal(writes(api.calls).length, 0);
    assert.equal(api.calls.length, 1);
  });
}

test('fails safe on truncated, missing, malformed, or ambiguous baseline tree', async () => {
  for (const data of [
    { sha: BASE_TREE, truncated: true, tree: [] },
    { sha: BASE_TREE, tree: [] },
    { sha: BASE_TREE, truncated: false, tree: [] },
    { sha: BASE_TREE, truncated: false, tree: [entry('data/shop.csv', 'blob', '100644', sha(90))] },
    { sha: BASE_TREE, truncated: false, tree: [entry('data/shop.csv', 'blob', '120000', BASE_CSV)] },
    { sha: BASE_TREE, truncated: false, tree: [entry('data/SHOP.csv', 'blob', '100644', BASE_CSV)] },
    { sha: BASE_TREE, truncated: false, tree: [
      entry('data/shop.csv', 'blob', '100644', BASE_CSV), entry('DATA/shop.csv')
    ] },
    { sha: BASE_TREE, truncated: false, tree: [{}] }
  ]) {
    const api = mock({
      intercept: call => call.url.includes('/git/trees/') ? response(data) : undefined
    });
    await assert.rejects(publishShop(options(), api.fetchImpl));
    assert.equal(writes(api.calls).length, 0);
  }
});

test('validates baseline blob SHA, encoding and bounded payload', async () => {
  for (const extra of [
    { sha: sha(90) }, { encoding: 'utf-8' }, { size: 2 * 1024 * 1024 + 1 },
    { size: -1 }, { size: null }, { content: null }, { content: 'x'.repeat(3 * 1024 * 1024 + 1) }
  ]) {
    const api = mock({
      intercept: call => call.url.includes('/git/blobs/') ?
        response({ sha: BASE_CSV, encoding: 'base64', size: 4, content: 'aWQK', ...extra }) : undefined
    });
    await assert.rejects(publishShop(options(), api.fetchImpl));
    assert.equal(writes(api.calls).length, 0);
  }
});

test('existing files, case-folded files/directories, symlinks and nested collisions fail before blobs', async () => {
  for (const existing of [
    entry(photo().path), entry(photo().path.toUpperCase()),
    entry(`${photo().path}/child`), entry('images'),
    entry('images/products/test-body', 'blob', '120000'),
    entry('IMAGES', 'tree', '040000'), entry('images/products/TEST-body', 'tree', '040000')
  ]) {
    const api = mock({ entries: [existing] });
    await assert.rejects(publishShop(options(), api.fetchImpl), { code: 'collision' });
    assert.equal(writes(api.calls).length, 0);
  }
  const api = mock({
    entries: [
      entry('images', 'tree', '040000'), entry('images/products', 'tree', '040000'),
      entry('images/products/test-body', 'tree', '040000'), entry('images/products/test-body/other.png')
    ]
  });
  await publishShop(options(), api.fetchImpl);
});

test('partial photo upload failure leaves all photos failed and never creates a commit', async () => {
  const files = [photo(), photo('images/products/test-body/back.png')];
  const states = [];
  let count = 0;
  const api = mock({
    intercept: call => {
      if (call.method === 'POST' && call.url.endsWith('/blobs') && ++count === 2) {
        throw new Error(TOKEN);
      }
    }
  });
  await assert.rejects(publishShop(options({
    photos: files, onPhotoState: (path, state) => states.push([path, state])
  }), api.fetchImpl), { code: 'network' });
  assert.deepEqual(states, [
    ...files.map(file => [file.path, 'pending']), ...files.map(file => [file.path, 'failed'])
  ]);
  assert.equal(writes(api.calls).length, 2);
  assert.equal(patches(api.calls).length, 0);
});

test('retry recreates blobs without any Contents API overwrites', async () => {
  let failed = false;
  const api = mock({
    intercept: call => {
      if (!failed && call.method === 'POST' && call.url.endsWith('/trees')) {
        failed = true;
        return response({}, 500);
      }
    }
  });
  await assert.rejects(publishShop(options(), api.fetchImpl));
  await publishShop(options(), api.fetchImpl);
  assert.equal(api.calls.filter(call => call.method === 'POST' && call.url.endsWith('/blobs')).length, 4);
  assert.equal(patches(api.calls).length, 1);
  assert.equal(api.calls.some(call => call.url.includes('/contents/')), false);
});

test('unrelated concurrent branch change fails without updating ref', async () => {
  let reads = 0;
  const api = mock({
    intercept: call => call.url.includes('/git/ref/') && ++reads > 1 ? response(ref(sha(90))) : undefined
  });
  await assert.rejects(publishShop(options(), api.fetchImpl), { code: 'conflict' });
  assert.equal(patches(api.calls).length, 0);
});

test('CSV baseline is rechecked after creating the commit', async () => {
  let reads = 0;
  const api = mock({
    intercept: call => call.url.includes('/git/blobs/') && ++reads > 1 ?
      response({ sha: sha(90), encoding: 'base64', size: 4, content: 'aWQK' }) : undefined
  });
  await assert.rejects(publishShop(options(), api.fetchImpl));
  assert.equal(patches(api.calls).length, 0);
});

test('branch change during final baseline read fails the last head recheck', async () => {
  let reads = 0;
  const api = mock({
    intercept: call => call.url.includes('/git/ref/') && ++reads === 3 ? response(ref(sha(90))) : undefined
  });
  await assert.rejects(publishShop(options(), api.fetchImpl), { code: 'conflict' });
  assert.equal(patches(api.calls).length, 0);
});

for (const status of [409, 422, 403]) {
  test(`a racing or protected ref HTTP ${status} fails definitely and never completes photos`, async () => {
    const states = [];
    const api = mock({
      intercept: call => call.method === 'PATCH' ? response({ message: TOKEN }, status) : undefined
    });
    await assert.rejects(publishShop(options({
      onPhotoState: (_, state) => states.push(state)
    }), api.fetchImpl), { code: status === 403 ? 'permission' : 'conflict' });
    assert.deepEqual(states, ['pending', 'failed']);
    assert.equal(patches(api.calls).length, 1);
    assert.equal(patches(api.calls)[0].body.force, false);
  });
}

test('network loss during PATCH is truthfully ambiguous and preserves drafts', async () => {
  const api = mock({
    intercept: call => { if (call.method === 'PATCH') throw new Error(TOKEN); }
  });
  await assert.rejects(publishShop(options(), api.fetchImpl), error =>
    error.code === 'ambiguous' && /may have reached GitHub/.test(error.message) &&
    /Verify the repository before retrying; keep your drafts/.test(error.message) &&
    !error.message.includes(TOKEN));
});

test('cancellation or account changes during ref confirmation remain truthfully ambiguous', async () => {
  for (const invalidate of ['abort', 'account']) {
    const controller = new AbortController();
    let current = true;
    const states = [];
    const api = mock({
      intercept: call => call.method === 'PATCH' ?
        response({}, 200, {
          json: async () => {
            if (invalidate === 'abort') controller.abort(TOKEN);
            else current = false;
            return ref(COMMIT);
          }
        }) : undefined
    });
    await assert.rejects(publishShop(options({
      signal: controller.signal, isCurrent: () => current,
      onPhotoState: (_, state) => states.push(state)
    }), api.fetchImpl), error =>
      error.code === 'ambiguous' && /may have reached GitHub/.test(error.message) &&
      /Verify the repository before retrying; keep your drafts/.test(error.message) &&
      !error.message.includes(TOKEN) && !error.cause);
    assert.equal(patches(api.calls).length, 1);
    assert.deepEqual(states, ['pending', 'failed']);
  }
});

test('abort while ref request is in flight does not falsely claim publication failed', async () => {
  const controller = new AbortController();
  let reachedRef;
  const started = new Promise(resolve => { reachedRef = resolve; });
  const api = mock({
    intercept: async call => {
      if (call.method === 'PATCH') {
        reachedRef();
        await new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true });
        });
      }
    }
  });
  const result = publishShop(options({ signal: controller.signal }), api.fetchImpl);
  await started;
  controller.abort(TOKEN);
  await assert.rejects(result, error =>
    error.code === 'ambiguous' && /may have reached GitHub/.test(error.message) &&
    /Verify the repository before retrying; keep your drafts/.test(error.message) &&
    !error.message.includes(TOKEN));
  assert.equal(patches(api.calls).length, 1);
});

test('unreadable or mismatched successful PATCH is ambiguous, never completed', async () => {
  for (const result of [
    response(ref(sha(90))),
    response(ref(COMMIT, 'wrong-branch')),
    response({}, 200, { json: async () => { throw new Error(TOKEN); } }),
    response({}, 302), response({}, 500)
  ]) {
    const states = [];
    const api = mock({ intercept: call => call.method === 'PATCH' ? result : undefined });
    await assert.rejects(publishShop(options({
      onPhotoState: (_, state) => states.push(state)
    }), api.fetchImpl), { code: 'ambiguous' });
    assert.deepEqual(states, ['pending', 'failed']);
  }
});

test('pre-aborted or invalidated accounts do no networking', async () => {
  const controller = new AbortController();
  controller.abort(TOKEN);
  for (const override of [
    { signal: controller.signal }, { isCurrent: () => false },
    { isCurrent: () => { throw new Error(TOKEN); } }
  ]) {
    const api = mock();
    await assert.rejects(publishShop(options(override), api.fetchImpl), error => !error.message.includes(TOKEN));
    assert.equal(api.calls.length, 0);
  }
});

test('abort and account invalidation are checked after every awaited response', async () => {
  const baseline = mock();
  await publishShop(options(), baseline.fetchImpl);
  const requestCount = baseline.calls.length;
  for (const invalidation of ['abort', 'account']) {
    for (let index = 1; index <= requestCount; index++) {
      const controller = new AbortController();
      let current = true;
      const states = [];
      const api = mock({
        intercept: (_, calls) => {
          if (calls.length === index) {
            if (invalidation === 'abort') controller.abort(TOKEN);
            else current = false;
          }
        }
      });
      await assert.rejects(publishShop(options({
        signal: controller.signal, isCurrent: () => current,
        onPhotoState: (_, state) => states.push(state)
      }), api.fetchImpl), error =>
        error.code === (index === requestCount ? 'ambiguous' :
          invalidation === 'abort' ? 'aborted' : 'account_changed'));
      assert.equal(api.calls.length, index);
      assert.equal(patches(api.calls).length, index === requestCount ? 1 : 0);
      assert.equal(states.includes('completed'), false);
      for (const call of api.calls) assert.equal(call.signal, controller.signal);
    }
  }
});

test('account invalidation during response JSON and photo reading prevents subsequent writes', async () => {
  let current = true;
  const api = mock({
    intercept: () => response(ref(), 200, { json: async () => { current = false; return ref(); } })
  });
  await assert.rejects(publishShop(options({ isCurrent: () => current }), api.fetchImpl), { code: 'account_changed' });
  assert.equal(api.calls.length, 1);
  current = true;
  const file = photo();
  file.blob.arrayBuffer = async () => { current = false; return new ArrayBuffer(3); };
  const blobApi = mock();
  await assert.rejects(publishShop(options({ photos: [file], isCurrent: () => current }), blobApi.fetchImpl),
    { code: 'account_changed' });
  assert.equal(writes(blobApi.calls).length, 0);
});

test('photo read failures never echo foreign errors, including foreign error codes', async () => {
  const file = photo();
  file.blob.arrayBuffer = async () => {
    const error = new Error(TOKEN);
    error.code = 'unsafe';
    throw error;
  };
  const api = mock();
  await assert.rejects(publishShop(options({ photos: [file] }), api.fetchImpl), error =>
    error.code === 'photo_read' && !error.message.includes(TOKEN));
  assert.equal(writes(api.calls).length, 0);
});

test('pending observers can invalidate accounts, completed observers cannot cause false failures', async () => {
  let current = true;
  const api = mock();
  await assert.rejects(publishShop(options({
    isCurrent: () => current, onPhotoState: (_, state) => { if (state === 'pending') current = false; }
  }), api.fetchImpl), { code: 'account_changed' });
  assert.equal(writes(api.calls).length, 0);
  const success = mock();
  assert.deepEqual(await publishShop(options({
    onPhotoState: () => { throw new Error(TOKEN); }
  }), success.fetchImpl), { csvSha: CSV, commitSha: COMMIT });
});

test('rejects invalid API SHA values and unexpected references without later writes', async () => {
  for (const result of [
    response(ref('main')), response(ref(HEAD, 'other')),
    response({ ref: 'refs/heads/main', object: { type: 'tree', sha: HEAD } }),
    response(null)
  ]) {
    const api = mock({ intercept: () => result });
    await assert.rejects(publishShop(options(), api.fetchImpl));
    assert.equal(api.calls.length, 1);
  }
  const api = mock({
    intercept: call => call.method === 'POST' && call.url.endsWith('/blobs') ?
      response({ sha: '../../unsafe' }, 201) : undefined
  });
  await assert.rejects(publishShop(options(), api.fetchImpl));
  assert.equal(writes(api.calls).length, 1);
});

test('snapshots input photo paths against mutation during asynchronous operations', async () => {
  const files = [photo()];
  const originalPath = files[0].path;
  const api = mock({ intercept: () => { files[0].path = '../evil'; } });
  await publishShop(options({ photos: files }), api.fetchImpl);
  assert.equal(writes(api.calls).find(call => call.url.endsWith('/trees')).body.tree[0].path, originalPath);
});
