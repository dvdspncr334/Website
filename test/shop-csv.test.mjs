import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOP_COLUMNS, parseShopCSV, serializeShopCSV, validateProduct, validateAll
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
