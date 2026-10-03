const API = 'https://api.github.com';
const CSV_PATH = 'data/shop.csv';
const MB = 1024 * 1024;
export const PUBLISH_LIMITS = Object.freeze({
  maxPhotos: 20,
  maxPhotoBytes: 10 * MB,
  maxTotalBytes: 40 * MB,
  maxCsvBytes: 2 * MB
});
const SHA = /^[a-f0-9]{40}$/;
const SAFE_ERROR = Symbol('publish error');
const PHOTO_PATH = /^images\/products\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9_-]*\.(jpg|jpeg|png|webp)$/;
const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp'
};

function failure(message, code = 'publish_failed') {
  const error = new Error(message);
  error.code = code;
  error[SAFE_ERROR] = true;
  return error;
}

function validBranch(branch) {
  return typeof branch === 'string' && branch.length <= 255 &&
    branch.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) &&
      !part.endsWith('.') && !part.endsWith('.lock') && !part.includes('..'));
}

function requireSha(value) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw failure('GitHub returned an invalid object identifier.');
  }
  return value;
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  }
  return btoa(chunks.join(''));
}

// Git objects remain unreachable until the single, non-forced branch update.
export async function publishShop({
  owner, repo, branch, token, message, csv, baseSha, photos = [],
  signal, onPhotoState, isCurrent = () => true
}, fetchImpl = fetch) {
  let refAttempted = false;
  let refConfirmed = false;
  let definiteRefFailure = false;
  const files = Array.isArray(photos) ? photos.map(photo => ({ path: photo?.path, blob: photo?.blob })) : [];
  const check = () => {
    if (signal?.aborted) {
      const error = failure('Publishing was cancelled. Keep your drafts.', 'aborted');
      error.name = 'AbortError';
      throw error;
    }
    let current = false;
    try { current = isCurrent(); } catch { /* Treat a broken account guard as invalidation. */ }
    if (!current) {
      throw failure('The account changed. Publishing stopped; keep your drafts.', 'account_changed');
    }
  };
  const state = (path, value) => {
    // UI callbacks cannot turn a confirmed publication into a retryable failure.
    try { onPhotoState?.(path, value); } catch { /* Ignore observer errors. */ }
  };
  const failedAttempt = error => {
    for (const { path } of files) state(path, 'failed');
    if (refAttempted && !refConfirmed && !definiteRefFailure) {
      return failure('The publication may have reached GitHub. Verify the repository before retrying; keep your drafts.', 'ambiguous');
    }
    // Never propagate server, fetch, Blob or account-callback error text.
    return error?.[SAFE_ERROR] ? error : failure('Publishing failed. Keep your drafts.', 'publish_failed');
  };

  try {
    check();
    if (typeof owner !== 'string' || owner.length > 39 ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner) ||
        typeof repo !== 'string' || repo.length > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) ||
        repo.includes('..') || !validBranch(branch)) {
      throw failure('Configure a valid GitHub owner, repository and branch.', 'invalid_target');
    }
    if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) {
      throw failure('A valid GitHub token is required.', 'invalid_token');
    }
    if (typeof message !== 'string' || !message.trim() || message.length > 10000) {
      throw failure('A bounded, nonempty commit message is required.', 'invalid_input');
    }
    if (typeof csv !== 'string' || new TextEncoder().encode(csv).length > PUBLISH_LIMITS.maxCsvBytes) {
      throw failure('The CSV must be text no larger than 2 MB.', 'invalid_input');
    }
    if (typeof baseSha !== 'string' || !SHA.test(baseSha)) {
      throw failure('A valid baseline CSV identifier is required.', 'invalid_input');
    }
    if (!Array.isArray(photos) || photos.length > PUBLISH_LIMITS.maxPhotos) {
      throw failure('Publish at most 20 photos at a time.', 'invalid_input');
    }
    let total = new TextEncoder().encode(csv).length;
    const paths = new Set();
    for (const { path, blob } of files) {
      const match = typeof path === 'string' && path.length <= 240 && PHOTO_PATH.exec(path);
      if (!match || paths.has(path.toLowerCase())) {
        throw failure('Photo paths must be unique, safe images/products/slug/name.ext paths.', 'invalid_input');
      }
      if (!(blob instanceof Blob) || blob.type !== TYPES[match[1]] ||
          blob.size <= 0 || blob.size > PUBLISH_LIMITS.maxPhotoBytes) {
        throw failure('Photos must be matching JPEG, PNG or WebP files no larger than 10 MB.', 'invalid_input');
      }
      total += blob.size;
      paths.add(path.toLowerCase());
    }
    if (total > PUBLISH_LIMITS.maxTotalBytes) {
      throw failure('The combined upload must be no larger than 40 MB.', 'invalid_input');
    }
  } catch (error) {
    throw failedAttempt(error);
  }

  const root = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const refPath = `heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const request = async (path, method = 'GET', body) => {
    check();
    let response;
    if (method === 'PATCH') refAttempted = true;
    try {
      response = await fetchImpl(`${root}${path}`, {
        method, redirect: 'error', credentials: 'omit', signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: ['Bearer', token].join(' '),
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch {
      check();
      throw failure('GitHub could not be reached. Keep your drafts and retry.', 'network');
    }
    check();
    if (response.redirected || (response.status >= 300 && response.status < 400) ||
        (response.url && new URL(response.url).origin !== API)) {
      throw failure('GitHub redirects are not permitted.', 'redirect');
    }
    if (!response.ok) {
      if (method === 'PATCH' && [400, 401, 403, 404, 409, 422, 429].includes(response.status)) {
        definiteRefFailure = true;
      }
      if (response.status === 409 || response.status === 422) {
        throw failure('The branch conflicted with this publication. Reload before retrying; keep your drafts.', 'conflict');
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw failure('Check the configured repository, branch and token write permissions, then retry. Keep your drafts.', 'permission');
      }
      throw failure('GitHub rejected the publication. Keep your drafts and retry.', 'http');
    }
    let data;
    try { data = await response.json(); } catch {
      check();
      throw failure('GitHub returned an unreadable response. Keep your drafts.', 'response');
    }
    check();
    return data;
  };
  const head = async () => {
    const data = await request(`/git/ref/${refPath}`);
    if (data?.ref !== `refs/heads/${branch}` || data?.object?.type !== 'commit') {
      throw failure('GitHub returned an unexpected branch reference.', 'response');
    }
    return requireSha(data.object.sha);
  };
  const readTree = async commitSha => {
    const commit = await request(`/git/commits/${commitSha}`);
    if (requireSha(commit?.sha) !== commitSha) {
      throw failure('GitHub returned an unexpected commit.', 'response');
    }
    const treeSha = requireSha(commit?.tree?.sha);
    const tree = await request(`/git/trees/${treeSha}?recursive=1`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree) ||
        requireSha(tree.sha) !== treeSha ||
        tree.tree.some(entry => typeof entry?.path !== 'string')) {
      throw failure('The repository tree is incomplete; publishing is unsafe.', 'incomplete_tree');
    }
    const csvEntries = tree.tree.filter(entry => entry.path.toLowerCase() === CSV_PATH);
    const entry = csvEntries[0];
    if (csvEntries.length !== 1 || entry.path !== CSV_PATH ||
        entry.type !== 'blob' || entry.mode !== '100644' ||
        requireSha(entry.sha) !== baseSha) {
      throw failure('The CSV baseline changed. Reload before publishing; keep your drafts.', 'conflict');
    }
    const blob = await request(`/git/blobs/${entry.sha}`);
    if (requireSha(blob?.sha) !== baseSha || blob.encoding !== 'base64' ||
        typeof blob.content !== 'string' || !Number.isInteger(blob.size) ||
        blob.size < 0 || blob.size > PUBLISH_LIMITS.maxCsvBytes || blob.content.length > 3 * MB) {
      throw failure('The baseline CSV blob is invalid or too large.', 'response');
    }
    return { treeSha, entries: tree.tree };
  };
  try {
    const initialHead = await head();
    const { treeSha, entries } = await readTree(initialHead);
    for (const { path } of files) {
      const lower = path.toLowerCase();
      if (entries.some(entry => {
        const existing = entry.path.toLowerCase();
        return existing === lower || existing.startsWith(`${lower}/`) ||
          (lower.startsWith(`${existing}/`) &&
            (entry.type !== 'tree' || entry.path !== path.slice(0, entry.path.length)));
      })) {
        throw failure('A photo path already exists or collides with the repository. Generate a new path.', 'collision');
      }
    }
    const treeEntries = [];
    for (const { path } of files) {
      check();
      state(path, 'pending');
      check();
    }
    for (const { path, blob } of files) {
      check();
      let buffer;
      try { buffer = await blob.arrayBuffer(); } catch {
        check();
        throw failure('A photo could not be read. Keep your drafts.', 'photo_read');
      }
      check();
      const result = await request('/git/blobs', 'POST', {
        content: base64(buffer), encoding: 'base64'
      });
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: requireSha(result?.sha) });
    }
    const csvBlob = await request('/git/blobs', 'POST', { content: csv, encoding: 'utf-8' });
    const csvSha = requireSha(csvBlob?.sha);
    treeEntries.push({ path: CSV_PATH, mode: '100644', type: 'blob', sha: csvSha });
    const tree = await request('/git/trees', 'POST', { base_tree: treeSha, tree: treeEntries });
    const commit = await request('/git/commits', 'POST', {
      message, tree: requireSha(tree?.sha), parents: [initialHead]
    });
    const commitSha = requireSha(commit?.sha);
    const latestHead = await head();
    if (latestHead !== initialHead) {
      throw failure('The branch changed while publishing. Reload before retrying; keep your drafts.', 'conflict');
    }
    await readTree(latestHead);
    // Check once more after the baseline reads; force:false catches a later race.
    if (await head() !== initialHead) {
      throw failure('The branch changed while publishing. Reload before retrying; keep your drafts.', 'conflict');
    }
    const updated = await request(`/git/refs/${refPath}`, 'PATCH', { sha: commitSha, force: false });
    if (updated?.ref !== `refs/heads/${branch}` || updated?.object?.type !== 'commit' ||
        requireSha(updated?.object?.sha) !== commitSha) {
      throw failure('GitHub did not confirm the requested branch update.', 'response');
    }
    check();
    refConfirmed = true;
    for (const { path } of files) state(path, 'completed');
    return { csvSha, commitSha };
  } catch (error) {
    throw failedAttempt(error);
  }
}
