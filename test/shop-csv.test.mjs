import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOP_COLUMNS, parseShopCSV, serializeShopCSV, validateProduct, validateAll, applyBulkUpdate, normalizeProduct
} from '../shop-csv.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = readFileSync(path.join(root, 'data', 'shop.csv'), 'utf8');

const valid = {
  id: 'strat-test', title: 'Test, Body', price: '199.99', img: 'images/placeholder.png',
  category: 'stratocaster', subcategory: 'standard-hss', handedness: 'both', colors: 'Red|Blue',
  custom_color_fee: '30', pickup_configs: 'HSS|SSS', description: 'Has "quotes", and commas',
  color_images: 'Red:images/a.png|Blue:https://example.com/b.png', status: 'made-to-order', tag: 'new', discount: '10'
};

test('the real data/shop.csv parses, validates and round-trips unchanged', () => {
  const { headers, rows, skipped } = parseShopCSV(csv);
  assert.deepEqual([...headers].sort(), [...SHOP_COLUMNS].sort());
  assert.ok(rows.length >= 10);
  assert.deepEqual(skipped, []);
  assert.deepEqual(validateAll(rows), []);
  const expected = csv.split(/\r?\n/).filter(line => line.replace(/,/g, '').trim()).join('\n') + '\n';
  assert.equal(serializeShopCSV(headers, rows), expected);
});

test('quoted fields with commas and quotes survive serialize -> parse', () => {
  const text = serializeShopCSV(SHOP_COLUMNS, [valid]);
  assert.match(text, /"Test, Body"/);
  assert.match(text, /"Has ""quotes"", and commas"/);
  const { rows } = parseShopCSV(text);
  assert.deepEqual(rows, [valid]);
});

test('rows with the wrong column count are reported as skipped', () => {
  const { rows, skipped } = parseShopCSV('id,title\na,b\nbroken\n,\nc,d\n');
  assert.deepEqual(rows.map(r => r.id), ['a', 'c']);
  assert.deepEqual(skipped, [3]);
});

test('unbalanced or misplaced quotes and ambiguous headers are reported, not silently rewritten', () => {
  for (const line of ['a,"unfinished', 'a,b"c"', 'a,"b"trailing', ',"']) {
    const parsed = parseShopCSV(`id,title\n${line}\nsafe,"Quoted ""title"", with comma"\n`);
    assert.deepEqual(parsed.skipped, [2]);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].title, 'Quoted "title", with comma');
  }
  for (const header of ['id,id', 'id,', '"id,title']) {
    assert.deepEqual(parseShopCSV(`${header}\na,b\n`).skipped, [1]);
  }
});

test('unknown columns and colon-containing color paths survive adding a product', () => {
  const original = { ...valid, future_field: 'Keep "this", too' };
  const headers = [...SHOP_COLUMNS, 'future_field'];
  const parsed = parseShopCSV(serializeShopCSV(headers, [original]));
  parsed.rows.push({ ...valid, id: 'new-product', future_field: 'new value' });
  const exported = parseShopCSV(serializeShopCSV(parsed.headers, parsed.rows));
  assert.deepEqual(exported.rows[0], original);
  assert.equal(exported.rows[1].color_images, 'Red:images/a.png|Blue:https://example.com/b.png');
});

test('unknown columns named like object properties are preserved as CSV data', () => {
  const headers = [...SHOP_COLUMNS, '__proto__', 'constructor'];
  const original = { ...valid, ['__proto__']: 'retain this column', constructor: 'retain that column' };
  const normalized = normalizeProduct(original, headers);
  const parsed = parseShopCSV(serializeShopCSV(headers, [normalized]));
  assert.equal(parsed.rows[0].__proto__, 'retain this column');
  assert.equal(parsed.rows[0].constructor, 'retain that column');
  assert.equal(Object.getPrototypeOf(parsed.rows[0]), Object.prototype);
});

test('a valid product has no errors', () => {
  assert.deepEqual(validateProduct(valid, []), {});
});

test('validation rejects bad ids, prices, lists, paths and markup', () => {
  const cases = [
    [{ id: '' }, 'id'],
    [{ id: 'Bad ID' }, 'id'],
    [{ price: 'abc' }, 'price'],
    [{ price: '-5' }, 'price'],
    [{ price: '1.999' }, 'price'],
    [{ price: '' }, 'price'],
    [{ title: '' }, 'title'],
    [{ img: 'javascript:alert(1)' }, 'img'],
    [{ img: '/images/a.png' }, 'img'],
    [{ img: 'http://example.com/a.png' }, 'img'],
    [{ colors: 'Red||Blue' }, 'colors'],
    [{ colors: 'Red|red' }, 'colors'],
    [{ pickup_configs: 'HSS|' }, 'pickup_configs'],
    [{ color_images: 'Red' }, 'color_images'],
    [{ color_images: 'Red:javascript:alert(1)' }, 'color_images'],
    [{ handedness: 'ambi' }, 'handedness'],
    [{ status: 'sold<script>' }, 'status'],
    [{ tag: '<b>x</b>' }, 'tag'],
    [{ discount: '150' }, 'discount'],
    [{ custom_color_fee: 'free' }, 'custom_color_fee'],
    [{ description: 'line1\nline2' }, 'description'],
    [{ title: '<img src=x onerror=alert(1)>' }, 'title'],
    [{ title: 'x'.repeat(201) }, 'title']
  ];
  for (const [change, field] of cases) {
    const errors = validateProduct({ ...valid, ...change }, []);
    assert.ok(errors[field], `${JSON.stringify(change)} should fail on ${field}`);
  }
});

test('ids must be unique (case-insensitive) across products', () => {
  const errors = validateProduct(valid, [{ ...valid, id: 'STRAT-TEST' }]);
  assert.match(errors.id, /already used/);
  const problems = validateAll([valid, { ...valid }]);
  assert.deepEqual(problems.map(p => p.index), [0, 1]);
});

test('bulk updates change only selected products without mutating the original rows', () => {
  const rows = [valid, { ...valid, id: 'tele-test' }];
  for (const [field, value] of [['price', '25.50'], ['discount', '100'], ['status', 'preorder']]) {
    const updated = applyBulkUpdate(rows, new Set([valid.id]), field, value);
    assert.equal(updated[0][field], value);
    assert.notEqual(updated[0], rows[0]);
    assert.equal(updated[1], rows[1]);
    assert.equal(rows[0], valid);
  }
  assert.deepEqual(applyBulkUpdate(rows, [], 'price', '20'), rows);
});

test('bulk edits use individual validation and fail atomically', () => {
  const rows = [valid, { ...valid, id: 'tele-test', img: '' }];
  for (const [field, value] of [['price', '-1'], ['price', '1e2'], ['discount', '101'], ['status', 'sold'], ['id', 'new-id']]) {
    assert.throws(() => applyBulkUpdate(rows, [valid.id], field, value));
  }
  assert.throws(() => applyBulkUpdate(rows, rows.map(row => row.id), 'price', '20'), /tele-test/);
  assert.equal(rows[0].price, '199.99');
  assert.equal(rows[1].price, '199.99');
});
