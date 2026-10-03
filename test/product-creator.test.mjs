import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createProductCreator, humanList, slugify, uniqueProductId } from '../product-creator.js';
import { SHOP_COLUMNS, validateProduct } from '../shop-csv.js';

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.files = [];
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; this.text = ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  focus() { this.ownerDocument.activeElement = this; }
  emit(type, extra = {}) {
    if (this.disabled && (type === 'click' || type === 'change')) return;
    for (const handler of this.listeners[type] || []) handler({ preventDefault() {}, target: this, ...extra });
  }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
const template = {
  id: 'body', title: 'Original body', price: '200', img: 'images/main.png',
  colors: 'Red|Blue', color_images: 'Red:images/red.png|Blue:images/main.png',
  pickup_configs: 'HSS|SSS', category: 'strat', subcategory: 'standard',
  custom: 'Unknown column preserved'
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  let confirmation = true;
  let permitted = true;
  const saved = [], revoked = [], changes = [];
  const document = {
    defaultView: { confirm: () => confirmation },
    createElement(tag) { return new Element(tag, this); }
  };
  const container = new Element('div', document);
  let serial = 0;
  const creator = createProductCreator({
    container, getRows: () => [template], getHeaders: () => [...SHOP_COLUMNS, 'custom'],
    onSave: (product, photos) => saved.push({ product, photos }),
    isAllowed: () => permitted, onChange: () => changes.push(true),
    photoOptions: {
      urlApi: {
        createObjectURL: () => `blob:photo-${++serial}`,
        revokeObjectURL: url => revoked.push(url)
      },
      decode: async () => ({ width: 3000, height: 1500, close() {} }),
      encode: async (_image, _w, _h, type) => new Blob(['photo'], { type })
    }, ...options
  });
  const find = predicate => container.all().find(predicate);
  const field = name => find(node => node.name === name);
  const button = text => find(node => node.tagName === 'BUTTON' && node.textContent === text);
  const error = () => find(node => node.className === 'creator-errors')?.textContent;
  const edit = (name, value) => { field(name).value = value; field(name).emit('input'); };
  const upload = files => {
    const input = find(node => node.type === 'file');
    input.files = files;
    input.emit('change');
  };
  return {
    creator, container, saved, revoked, changes, find, field, button, error, edit, upload,
    deny: () => { permitted = false; }, cancel: () => { confirmation = false; }
  };
}
function image(name = 'body.png') {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])], { type: 'image/png' });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

test('human lists map to the shop schema and slugs are unique', () => {
  assert.equal(humanList(' Red, Blue '), 'Red|Blue');
  assert.equal(humanList(''), '');
  for (const list of ['Red|Blue', 'Red:Blue', 'Red,,Blue', 'Red,red', 'Red\nBlue']) {
    assert.throws(() => humanList(list));
  }
  assert.equal(slugify('Élite <Body> / New'), 'elite-body-new');
  assert.equal(uniqueProductId('Body', [{ id: 'BODY' }, { id: 'body-2' }]), 'body-3');
});

test('duplicate retains unknown fields and existing paths but always receives a new ID', async () => {
  const f = fixture();
  assert.equal(f.creator.open(template), true);
  assert.equal(f.field('id').value, 'body-2');
  assert.equal(f.field('colors').value, 'Red, Blue');
  assert.equal(f.field('pickup_configs').value, 'HSS, SSS');
  assert.equal(f.button('Save to list').disabled, true);
  f.button('Review product').emit('click');
  assert.equal(f.error(), '');
  f.button('Save to list').emit('click');
  await tick();
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].product.custom, template.custom);
  assert.equal(f.saved[0].product.img, template.img);
  assert.equal(f.saved[0].product.color_images, 'Blue:images/main.png|Red:images/red.png');
  assert.equal(f.saved[0].product.pickup_configs, 'HSS|SSS');
  assert.deepEqual(f.saved[0].photos, []);
  assert.equal(f.creator.hasDraft(), false);
  assert.equal(template.id, 'body');
});

test('auto ID follows title until manually edited, category options come from existing rows', () => {
  const f = fixture();
  f.creator.open();
  f.edit('title', 'Body');
  assert.equal(f.field('id').value, 'body-2');
  f.edit('id', 'custom-body');
  f.edit('title', 'Other title');
  assert.equal(f.field('id').value, 'custom-body');
  assert.ok(f.container.all().some(node => node.tagName === 'OPTION' && node.value === 'strat'));
  const pickupSuggestions = f.find(node => node.tagName === 'DATALIST' && node.id.includes('pickup_configs'));
  assert.deepEqual(pickupSuggestions.children.map(node => node.value), ['HSS', 'SSS']);
  f.edit('category', 'custom-category');
  assert.equal(f.field('category').value, 'custom-category');
});

test('review validates, edits invalidate review, Save requires explicit review', () => {
  const f = fixture();
  f.creator.open();
  f.button('Review product').emit('click');
  assert.match(f.error(), /Title is required/);
  assert.equal(f.container.ownerDocument.activeElement.className, 'creator-errors');
  assert.equal(f.container.ownerDocument.activeElement.attributes.tabindex, '-1');
  assert.equal(f.button('Save to list').disabled, true);
  f.creator.clear();
  f.creator.open(template);
  f.button('Review product').emit('click');
  assert.equal(f.button('Save to list').disabled, false);
  f.edit('price', '20');
  assert.equal(f.button('Save to list').disabled, true);
  assert.equal(f.saved.length, 0);
});

test('canceling discard or replacement preserves the draft and preview URLs', async () => {
  const f = fixture();
  f.creator.open();
  f.upload([image()]);
  await tick();
  f.cancel();
  f.button('Discard draft').emit('click');
  assert.equal(f.creator.hasDraft(), true);
  assert.equal(f.creator.open(template), false);
  assert.deepEqual(f.revoked, []);
  f.creator.clear();
  assert.deepEqual(f.revoked, ['blob:photo-1']);
});

test('prepared photos get safe final paths, transfer only once, survive parent clear', async () => {
  if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  const f = fixture();
  f.creator.open();
  f.edit('title', 'New body');
  f.edit('price', '125.50');
  f.edit('colors', 'Red, Blue');
  f.edit('pickup_configs', 'HSS, SSS');
  f.upload([image()]);
  assert.equal(f.creator.isBusy(), true);
  assert.equal(f.creator.open(template), false);
  await tick();
  assert.equal(f.creator.isBusy(), false);
  const checkbox = f.find(node => node.attributes['aria-label'] === 'Use body.png for Red');
  checkbox.checked = true;
  checkbox.emit('change');
  f.button('Review product').emit('click');
  assert.equal(f.error(), '');
  f.button('Save to list').emit('click');
  f.button('Save to list').emit('click');
  await tick();
  const { product, photos } = f.saved[0];
  assert.deepEqual(validateProduct(product, [template]), {});
  assert.match(product.img, /^images\/products\/new-body\/[a-f0-9]{32}\.png$/);
  assert.equal(product.color_images, `Red:${product.img}`);
  assert.equal(product.colors, 'Red|Blue');
  assert.equal(product.pickup_configs, 'HSS|SSS');
  assert.equal(photos.length, 1);
  assert.deepEqual(Object.keys(photos[0]).sort(), ['blob', 'path', 'previewUrl', 'state']);
  assert.equal(photos[0].state, 'pending');
  assert.equal(photos[0].previewUrl, 'blob:photo-1');
  assert.doesNotMatch(JSON.stringify(product), /blob:/);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.revoked, []);
  f.creator.clear();
  f.creator.open();
  assert.deepEqual(f.revoked, []);
});

test('unused photos block review; removal revokes only that photo and permits save', async () => {
  const f = fixture();
  f.creator.open(template);
  f.upload([image()]);
  await tick();
  f.button('Review product').emit('click');
  assert.match(f.error(), /Every photo/);
  const newCard = f.find(node => node.className === 'creator-photo' && node.textContent.includes('body.png'));
  newCard.all().find(node => node.tagName === 'BUTTON' && node.textContent === 'Remove photo').emit('click');
  assert.deepEqual(f.revoked, ['blob:photo-1']);
  f.button('Review product').emit('click');
  assert.equal(f.error(), '');
});

test('drag/drop, reordering and exclusive color assignments produce only referenced staged files', async () => {
  const f = fixture();
  f.creator.open();
  f.edit('title', 'Two colors');
  f.edit('price', '100');
  f.edit('colors', 'Red');
  const zone = f.find(node => node.className === 'creator-dropzone');
  zone.emit('drop', { dataTransfer: { files: [image('first.png'), image('second.png')] } });
  await tick();
  const second = () => f.find(node => node.className === 'creator-photo' && node.textContent.includes('second.png'));
  second().all().find(node => node.textContent === 'Move earlier' && node.tagName === 'BUTTON').emit('click');
  const cards = f.container.all().filter(node => node.className === 'creator-photo');
  assert.match(cards[0].textContent, /second.png/);
  const assign = name => {
    const checkbox = f.find(node => node.attributes['aria-label'] === `Use ${name} for Red`);
    checkbox.checked = true;
    checkbox.emit('change');
  };
  assign('first.png');
  assign('second.png');
  assert.equal(f.find(node => node.attributes['aria-label'] === 'Use first.png for Red').checked, false);
  f.button('Review product').emit('click');
  assert.equal(f.error(), '');
  f.button('Save to list').emit('click');
  await tick();
  assert.equal(f.saved[0].photos.length, 2);
  const main = f.saved[0].product.img;
  const color = f.saved[0].product.color_images.slice('Red:'.length);
  assert.notEqual(main, color);
  assert.deepEqual(new Set(f.saved[0].photos.map(photo => photo.path)), new Set([main, color]));
  assert.deepEqual(f.revoked, []);
});

test('new photo batches fail atomically when processing fails or count limits are exceeded', async () => {
  const f = fixture();
  f.creator.open();
  const input = f.find(node => node.type === 'file');
  input.value = 'same-file';
  f.upload([image(), image('not-an-image.exe')]);
  assert.equal(f.container.ownerDocument.activeElement, f.field('title'));
  await tick();
  assert.match(f.error(), /JPEG/);
  assert.equal(f.container.ownerDocument.activeElement.className, 'creator-errors');
  assert.equal(input.value, '');
  assert.equal(f.container.all().filter(node => node.className === 'creator-photo').length, 0);
  assert.deepEqual(f.revoked, ['blob:photo-1']);
  assert.equal(f.creator.isBusy(), false);
  f.upload(Array.from({ length: 13 }, () => image()));
  await tick();
  assert.match(f.error(), /at most 12/);
  assert.equal(f.container.all().filter(node => node.className === 'creator-photo').length, 0);
});

test('transferred URLs survive a synchronous parent clear and a later async completion', async () => {
  let finish;
  const f = fixture({ onSave: (_row, photos) => {
    assert.equal(photos.length, 1);
    f.creator.clear();
    f.creator.open(template);
    return new Promise(resolve => { finish = resolve; });
  } });
  f.creator.open();
  f.edit('title', 'Transferred body');
  f.edit('price', '100');
  f.upload([image()]);
  await tick();
  f.button('Review product').emit('click');
  f.button('Save to list').emit('click');
  assert.equal(f.creator.hasDraft(), true);
  assert.equal(f.field('title').value, template.title);
  assert.deepEqual(f.revoked, []);
  finish();
  await tick();
  assert.equal(f.creator.hasDraft(), true);
  assert.equal(f.field('title').value, template.title);
  assert.deepEqual(f.revoked, []);
});

test('clear and auth loss guard stale asynchronous image decoding', async () => {
  for (const mode of ['clear', 'deny']) {
    let finish;
    const f = fixture({ photoOptions: {
      urlApi: { createObjectURL: () => 'blob:late', revokeObjectURL: () => f.revoked.push('blob:late') },
      decode: () => new Promise(resolve => { finish = resolve; }),
      encode: async () => new Blob(['safe'], { type: 'image/png' })
    } });
    f.creator.open();
    f.upload([image()]);
    await tick();
    if (mode === 'clear') f.creator.clear();
    else f.deny();
    finish({ width: 50, height: 50, close() {} });
    await tick();
    assert.equal(f.creator.hasDraft(), false);
    assert.equal(f.creator.isBusy(), false);
    assert.deepEqual(f.revoked, ['blob:late']);
    assert.equal(f.saved.length, 0);
  }
});

test('failed save retains the draft and restores URL ownership for retry or discard', async () => {
  const f = fixture({ onSave: async () => { throw new Error('Parent save failed'); } });
  f.creator.open();
  f.edit('title', 'Body');
  f.edit('price', '100');
  f.upload([image()]);
  await tick();
  f.button('Review product').emit('click');
  f.button('Save to list').emit('click');
  await tick();
  assert.equal(f.creator.hasDraft(), true);
  assert.equal(f.creator.isBusy(), false);
  assert.match(f.error(), /Parent save failed/);
  assert.equal(f.container.ownerDocument.activeElement.className, 'creator-errors');
  assert.deepEqual(f.revoked, []);
  f.creator.clear();
  assert.deepEqual(f.revoked, ['blob:photo-1']);
});

test('save paths are rebound to the latest edited ID, including after a failed save', async () => {
  const attempts = [];
  const f = fixture({ onSave: async (product, photos) => {
    attempts.push({ product, photos });
    if (attempts.length === 1) throw new Error('Retry');
  } });
  f.creator.open();
  f.edit('title', 'First identity');
  f.edit('price', '100');
  f.upload([image()]);
  await tick();
  f.edit('id', 'edited-after-upload');
  f.button('Review product').emit('click');
  f.button('Save to list').emit('click');
  await tick();
  assert.match(attempts[0].photos[0].path, /^images\/products\/edited-after-upload\//);
  f.edit('id', 'latest-identity');
  f.button('Review product').emit('click');
  f.button('Save to list').emit('click');
  await tick();
  assert.match(attempts[1].photos[0].path, /^images\/products\/latest-identity\//);
  assert.equal(attempts[1].product.img, attempts[1].photos[0].path);
  assert.equal(f.creator.hasDraft(), false);
  assert.deepEqual(f.revoked, []);
  assert.doesNotMatch(JSON.stringify(attempts[1].product), /blob:/);
});

test('live preview reflects sale price, availability and tag using text nodes', () => {
  const f = fixture();
  f.creator.open(template);
  f.edit('discount', '25');
  f.edit('tag', 'sale');
  f.edit('status', 'made-to-order');
  const preview = f.find(node => node.className === 'creator-preview');
  assert.match(preview.textContent, /\$200\.00 \$150\.00 \(25% off\)/);
  assert.match(preview.textContent, /Availability: made to order/);
  assert.equal(f.find(node => node.className === 'creator-preview-tag').textContent, 'sale');
});

test('templates with many colors retain every existing color and image assignment', async () => {
  const colors = Array.from({ length: 20 }, (_, n) => `Color ${n + 1}`);
  const largeTemplate = {
    ...template, colors: colors.join('|'),
    color_images: colors.map((color, n) => `${color}:images/color-${n + 1}.png`).join('|')
  };
  const f = fixture();
  f.creator.open(largeTemplate);
  assert.equal(f.field('colors').value, colors.join(', '));
  f.button('Review product').emit('click');
  assert.equal(f.error(), '');
  f.button('Save to list').emit('click');
  await tick();
  assert.equal(f.saved[0].product.colors, largeTemplate.colors);
  assert.equal(f.saved[0].product.color_images, largeTemplate.color_images);
  assert.equal(f.saved[0].product.img, largeTemplate.img);
});

test('auth denial clears draft and creator has no markup injection or persistence APIs', () => {
  const f = fixture();
  f.creator.open(template);
  f.deny();
  f.button('Review product').emit('click');
  assert.equal(f.creator.hasDraft(), false);
  assert.equal(f.creator.open(), false);
  const source = readFileSync(new URL('../product-creator.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|localStorage|sessionStorage/);
});
