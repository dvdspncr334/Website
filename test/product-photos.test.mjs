import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { PHOTO_LIMITS, imageType, checkPhotoBatch, photoPath, preparePhoto } from '../product-photos.js';

const signatures = {
  'image/jpeg': [255, 216, 255, 224, 0, 0, 0, 0, 0, 0, 0, 0],
  'image/png': [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0],
  'image/webp': [...Buffer.from('RIFF1234WEBP')]
};
function file(type = 'image/jpeg', name = 'body.jpg', bytes = signatures[type]) {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}
function environment(overrides = {}) {
  const calls = [];
  return {
    calls,
    decode: async () => ({ width: 4000, height: 3000, close: () => calls.push('closed') }),
    encode: async (_image, width, height, type, quality) => {
      calls.push({ width, height, type, quality });
      return new Blob(['processed'], { type });
    },
    urlApi: { createObjectURL: () => 'blob:preview' },
    ...overrides
  };
}

test('only JPEG, PNG and WebP signatures are accepted', () => {
  for (const [type, bytes] of Object.entries(signatures)) assert.equal(imageType(bytes), type);
  assert.equal(imageType([...Buffer.from('<svg></svg>')]), '');
  assert.equal(imageType([77, 90, 0, 0]), '');
  assert.equal(imageType([]), '');
});

test('batch limits enforce nonempty files, per-file, total and count including originals', () => {
  assert.equal(PHOTO_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.throws(() => checkPhotoBatch([{ size: PHOTO_LIMITS.maxFileBytes + 1 }]), /Each photo/);
  assert.throws(() => checkPhotoBatch([{ size: 0 }]), /nonempty/);
  assert.throws(() => checkPhotoBatch([{ size: 11 }], [], { maxFileBytes: 10 }), /Each photo/);
  assert.throws(() => checkPhotoBatch([{ size: 10 }], [{ originalSize: 9 }], { maxTotalBytes: 18 }), /combined/);
  assert.throws(() => checkPhotoBatch([{ size: 1 }], [{}], { maxCount: 1 }), /at most 1/);
  assert.doesNotThrow(() => checkPhotoBatch([{ size: 10 }], [{ originalSize: 8 }], { maxTotalBytes: 18 }));
});

test('paths use secure random names, actual output extensions and validated IDs', () => {
  const first = photoPath('strat-body', 'image/jpeg', webcrypto);
  assert.match(first, /^images\/products\/strat-body\/[a-f0-9]{32}\.jpg$/);
  assert.notEqual(first, photoPath('strat-body', 'image/jpeg', webcrypto));
  assert.match(photoPath('strat-body', 'image/png', webcrypto), /\.png$/);
  for (const id of ['../evil', 'a/b', 'a\\b', 'Bad ID', '', 'a'.repeat(101)]) {
    assert.throws(() => photoPath(id, 'image/png', webcrypto), /valid product ID/);
  }
  assert.throws(() => photoPath('body', 'image/svg+xml', webcrypto), /Unsupported/);
  assert.throws(() => photoPath('body', 'image/png', {}), /Secure random/);
});

test('safe decoding resizes with default quality, reports sizes and closes the decoder', async () => {
  const env = environment();
  const photo = await preparePhoto(file(), env);
  assert.deepEqual(env.calls, [{ width: 2000, height: 1500, type: 'image/jpeg', quality: 0.9 }, 'closed']);
  assert.equal(photo.previewUrl, 'blob:preview');
  assert.equal(photo.originalWidth, 4000);
  assert.equal(photo.originalSize, 12);
  assert.equal(photo.state, 'pending');
  assert.equal(photo.blob.type, 'image/jpeg');
  assert.equal(PHOTO_LIMITS.maxDimension, 2000);
});

test('transparent formats stay PNG/WebP; keep original still requires valid decoding', async () => {
  for (const [type, name] of [['image/png', 'alpha.png'], ['image/webp', 'alpha.webp']]) {
    const env = environment();
    const photo = await preparePhoto(file(type, name), env);
    assert.equal(photo.type, type);
    assert.equal(env.calls[0].type, type);
  }
  const original = file();
  const env = environment({ keepOriginal: true });
  const photo = await preparePhoto(original, env);
  assert.equal(photo.blob, original);
  assert.equal(photo.width, 4000);
  assert.deepEqual(env.calls, ['closed']);
});

test('mislabeled, SVG and executable input is rejected before decoding', async () => {
  let decodes = 0;
  const env = environment({ decode: async () => { decodes += 1; } });
  for (const bad of [
    file('image/jpeg', 'body.jpg', [...Buffer.from('<svg onload="bad"></svg>')]),
    file('image/jpeg', 'body.jpg', [77, 90, 1, 2]),
    file('image/jpeg', 'body.exe'),
    file('image/png', 'body.jpg'),
    file('image/jpeg', 'body.png')
  ]) await assert.rejects(preparePhoto(bad, env), /match|JPEG/);
  assert.equal(decodes, 0);
});

test('corrupt images, excessive decoded dimensions and invalid resize options fail safely', async () => {
  await assert.rejects(preparePhoto(file(), environment({ decode: async () => { throw new Error('corrupt'); } })), /corrupt/);
  const env = environment({ decode: async () => ({ width: 50000, height: 50000, close: () => env.calls.push('closed') }) });
  await assert.rejects(preparePhoto(file(), env), /large dimensions/);
  assert.deepEqual(env.calls, ['closed']);
  for (const overrides of [{ maxDimension: 0 }, { quality: 2 }, { quality: NaN }]) {
    await assert.rejects(preparePhoto(file(), environment(overrides)), /valid resize/);
  }
});

test('browser encoder fallback uses its real supported MIME for the saved extension', async () => {
  const photo = await preparePhoto(file('image/webp', 'alpha.webp'), environment({
    encode: async () => new Blob(['png'], { type: 'image/png' })
  }));
  assert.equal(photo.type, 'image/png');
  assert.match(photoPath('body', photo.type, webcrypto), /\.png$/);
});
