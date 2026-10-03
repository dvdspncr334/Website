// Parse, validate and serialize data/shop.csv for the admin shop editor.
// Pure functions only (no DOM, no network) so they can be unit tested.

export const SHOP_COLUMNS = [
  'id', 'title', 'price', 'img', 'category', 'subcategory', 'handedness', 'colors',
  'custom_color_fee', 'pickup_configs', 'description', 'color_images', 'status', 'tag', 'discount'
];

export const HANDEDNESS_VALUES = ['', 'both', 'right', 'left'];
export const STATUS_VALUES = ['', 'in-stock', 'made-to-order', 'preorder'];

const MAX_LENGTHS = {
  id: 100, title: 200, price: 12, img: 500, category: 60, subcategory: 60, handedness: 10,
  colors: 1000, custom_color_fee: 12, pickup_configs: 300, description: 1000,
  color_images: 5000, status: 30, tag: 30, discount: 6
};

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const MONEY = /^\d{1,6}(\.\d{1,2})?$/;

// Same quoting rules as shop.html: "a, b" keeps the comma, "" is a quote.
export function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

// Returns { headers, rows, skipped } where skipped lists 1-based line numbers
// of rows whose column count doesn't match the header (shop.html skips them too).
export function parseShopCSV(text) {
  const lines = String(text || '').split(/\r?\n/);
  let headerIndex = lines.findIndex(line => line.trim());
  if (headerIndex < 0) return { headers: [...SHOP_COLUMNS], rows: [], skipped: [] };
  const fileHeaders = parseCSVLine(lines[headerIndex].trim());
  const headers = [...fileHeaders, ...SHOP_COLUMNS.filter(c => !fileHeaders.includes(c))];
  const rows = [];
  const skipped = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseCSVLine(line);
    if (values.every(v => !v)) continue; // rows of only commas are spacers
    if (values.length !== fileHeaders.length) {
      skipped.push(i + 1);
      continue;
    }
    const row = {};
    headers.forEach((h, idx) => { row[h] = idx < values.length ? values[idx] : ''; });
    rows.push(row);
  }
  return { headers, rows, skipped };
}

function quoteField(value) {
  const text = value == null ? '' : String(value);
  if (/[",]/.test(text) || text !== text.trim()) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function serializeShopCSV(headers, rows) {
  const lines = [headers.map(quoteField).join(',')];
  for (const row of rows) lines.push(headers.map(h => quoteField(row[h])).join(','));
  return `${lines.join('\n')}\n`;
}

// Document-relative paths (images/...) or https URLs only; no javascript:,
// data: or root-relative paths (the site is served under a sub-path).
function isSafePath(value) {
  return /^https:\/\/\S+$/i.test(value) || (!value.includes(':') && !value.startsWith('/') && !value.includes('\\'));
}

function isNumberInRange(value, min, max) {
  if (!MONEY.test(value)) return false;
  const n = Number(value);
  return n >= min && n <= max;
}

function pipeList(value) {
  return value.split('|').map(part => part.trim());
}

// Trims every field and returns a new product object with only known columns
// plus any extra columns present in `headers`.
export function normalizeProduct(product, headers = SHOP_COLUMNS) {
  const out = {};
  for (const h of headers) out[h] = product && product[h] != null ? String(product[h]).trim() : '';
  return out;
}

// Validates one product. `others` are the remaining products (used for the
// unique id check). Returns an object of field -> message; empty when valid.
export function validateProduct(product, others = []) {
  const p = normalizeProduct(product, [...new Set([...SHOP_COLUMNS, ...Object.keys(product || {})])]);
  const errors = {};
  const get = key => (p[key] == null ? '' : p[key]);

  for (const [key, value] of Object.entries(p)) {
    if (/[\r\n]/.test(value)) errors[key] = 'Line breaks are not allowed.';
    else if (/[<>]/.test(value)) errors[key] = 'The characters < and > are not allowed.';
    else if (MAX_LENGTHS[key] && value.length > MAX_LENGTHS[key]) errors[key] = `Must be at most ${MAX_LENGTHS[key]} characters.`;
  }
  const set = (key, message) => { if (!errors[key]) errors[key] = message; };

  const id = get('id');
  if (!id) set('id', 'ID is required.');
  else if (!SLUG.test(id)) set('id', 'Use lowercase letters, numbers and dashes only (e.g. strat-hss-normal).');
  else if (others.some(o => o && String(o.id || '').trim().toLowerCase() === id.toLowerCase())) set('id', `ID "${id}" is already used by another product.`);

  if (!get('title')) set('title', 'Title is required.');

  const price = get('price');
  if (!price) set('price', 'Price is required.');
  else if (!isNumberInRange(price, 0, 100000)) set('price', 'Price must be a number from 0 to 100000 with at most 2 decimals.');

  const img = get('img');
  if (!img) set('img', 'Image path is required (e.g. images/placeholder.png).');
  else if (!isSafePath(img)) set('img', 'Use a site-relative path (images/...) or an https:// URL.');

  for (const key of ['category', 'subcategory']) {
    const value = get(key);
    if (value && !SLUG.test(value)) set(key, 'Use lowercase letters, numbers and dashes only.');
  }

  if (!HANDEDNESS_VALUES.includes(get('handedness'))) set('handedness', 'Must be empty, both, right or left.');
  if (!STATUS_VALUES.includes(get('status'))) set('status', 'Must be empty, in-stock, made-to-order or preorder.');

  const colors = get('colors');
  const colorList = colors ? pipeList(colors) : [];
  if (colors && colorList.some(c => !c || c.includes(':'))) {
    set('colors', 'Separate colors with | (e.g. Red|Blue|Black); no empty entries or ":".');
  } else if (new Set(colorList.map(c => c.toLowerCase())).size !== colorList.length) {
    set('colors', 'Each color may only be listed once.');
  }

  const fee = get('custom_color_fee');
  if (fee && !isNumberInRange(fee, 0, 10000)) set('custom_color_fee', 'Fee must be a number from 0 to 10000.');

  const pickups = get('pickup_configs');
  if (pickups && pipeList(pickups).some(part => !part)) set('pickup_configs', 'Separate pickup configs with | (e.g. HSS|SSS); no empty entries.');

  const colorImages = get('color_images');
  if (colorImages) {
    for (const pair of pipeList(colorImages)) {
      const idx = pair.indexOf(':');
      const color = idx > 0 ? pair.slice(0, idx).trim() : '';
      const path = idx > 0 ? pair.slice(idx + 1).trim() : '';
      if (!color || !path || !isSafePath(path)) {
        set('color_images', 'Use Color:path pairs separated by | (e.g. Red:images/a.png|Blue:images/b.png).');
        break;
      }
    }
  }

  const tag = get('tag');
  if (tag && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(tag)) set('tag', 'Use letters, numbers, spaces and dashes only (e.g. new, sale).');

  const discount = get('discount');
  if (discount && !isNumberInRange(discount, 0, 100)) set('discount', 'Discount is a percentage from 0 to 100.');

  return errors;
}

// Validates every row. Returns [{ index, id, errors }] for rows with problems.
export function validateAll(rows) {
  const problems = [];
  rows.forEach((row, index) => {
    const others = rows.filter((_, i) => i !== index);
    const errors = validateProduct(row, others);
    if (Object.keys(errors).length) problems.push({ index, id: row.id || '', errors });
  });
  return problems;
}
