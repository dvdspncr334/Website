import { SHOP_COLUMNS, HANDEDNESS_VALUES, STATUS_VALUES, normalizeProduct, validateProduct } from './shop-csv.js';
import { PHOTO_LIMITS, checkPhotoBatch, photoPath, preparePhoto } from './product-photos.js';

export function slugify(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
}

export function uniqueProductId(value, rows = []) {
  const base = slugify(value) || 'product';
  const used = new Set(rows.map(row => String(row.id || '').trim().toLowerCase()));
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function humanList(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/[|:\r\n]/.test(text)) throw new Error('Use commas to separate options, not pipes, colons or line breaks.');
  const entries = text.split(',').map(item => item.trim());
  if (entries.some(item => !item)) throw new Error('Each comma-separated option needs a name.');
  if (new Set(entries.map(item => item.toLowerCase())).size !== entries.length) throw new Error('Each option may only be listed once.');
  return entries.join('|');
}

function safeImage(path) {
  return !!path && !/[\s<>\\|]/.test(path) && !/(^|\/)\.\.(\/|$)/.test(path) &&
    (/^https:\/\/[^/]+\/?/i.test(path) || (!path.includes(':') && !path.startsWith('/')));
}

function templatePhotos(template) {
  const photos = [];
  if (safeImage(template?.img)) photos.push({ existingPath: template.img, previewUrl: template.img, main: true, colors: [], name: 'Existing main photo' });
  for (const pair of String(template?.color_images || '').split('|').filter(Boolean)) {
    const split = pair.indexOf(':');
    const color = pair.slice(0, split).trim();
    const path = pair.slice(split + 1).trim();
    if (split < 1 || !safeImage(path)) continue;
    let photo = photos.find(item => item.existingPath === path);
    if (!photo) {
      photo = { existingPath: path, previewUrl: path, main: false, colors: [], name: `Existing ${color} photo` };
      photos.push(photo);
    }
    photo.colors.push(color);
  }
  return photos;
}

// Parent owns successful saved photo URLs and must revoke them on publish/discard.
// clear() is the forced auth/session reset; UI discard always asks first.
export function createProductCreator({
  container, getRows = () => [], getHeaders = () => SHOP_COLUMNS,
  onSave, isAllowed = () => true, onChange = () => {}, photoOptions = {}
}) {
  const document = container.ownerDocument;
  const window = document.defaultView || globalThis;
  const urlApi = photoOptions.urlApi || globalThis.URL;
  let draft = null;
  let photos = [];
  let busy = false;
  let reviewed = false;
  let generation = 0;
  let autoId = true;
  let fields = {};
  let root, photoList, preview, errors, reviewPanel, reviewButton, saveButton, discardButton;
  let input, resize, quality, original, controls = [], photoControls = [];
  const changed = () => onChange();
  const allowed = () => {
    if (isAllowed()) return true;
    clear();
    return false;
  };
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action, parent) => {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    parent.append(node);
    controls.push(node);
    return node;
  };
  const message = (text, focus = false) => {
    if (!errors) return;
    errors.textContent = text;
    if (focus && text) errors.focus();
  };
  const release = photo => { if (photo.blob && !photo.transferred) urlApi.revokeObjectURL(photo.previewUrl); };

  function clear() {
    generation += 1;
    photos.forEach(release);
    photos = [];
    draft = null;
    busy = false;
    reviewed = false;
    fields = {};
    container.replaceChildren();
    container.hidden = true;
    changed();
  }

  function setBusy(value) {
    busy = value;
    root?.setAttribute('aria-busy', String(value));
    controls.forEach(control => { control.disabled = value; });
    Object.values(fields).forEach(control => { control.disabled = value; });
    if (saveButton) saveButton.disabled = value || !reviewed;
    changed();
  }

  function invalidate() {
    reviewed = false;
    reviewPanel.hidden = true;
    saveButton.disabled = true;
    message('');
    updatePreview();
    changed();
  }

  function colors() {
    try { return humanList(fields.colors.value).split('|').filter(Boolean); } catch { return []; }
  }

  function readProduct(assignPaths = false) {
    const headers = [...new Set([...SHOP_COLUMNS, ...getHeaders(), ...Object.keys(draft)])];
    const product = normalizeProduct(draft, headers);
    for (const [name, field] of Object.entries(fields)) product[name] = field.value.trim();
    product.colors = humanList(fields.colors.value);
    product.pickup_configs = humanList(fields.pickup_configs.value);
    const pathFor = photo => {
      if (photo.existingPath) return photo.existingPath;
      if (assignPaths) {
        if (photo.pathId !== product.id) {
          photo.path = photoPath(product.id, photo.type);
          photo.pathId = product.id;
        }
        return photo.path;
      }
      return 'images/placeholder.png';
    };
    const main = photos.find(photo => photo.main);
    product.img = main ? pathFor(main) : '';
    product.color_images = photos.flatMap(photo => photo.colors.map(color => `${color}:${pathFor(photo)}`)).join('|');
    if (Object.values(product).some(value => /blob:/i.test(value))) throw new Error('Temporary preview URLs cannot be saved.');
    return product;
  }

  function validate(assignPaths = false) {
    const product = readProduct(assignPaths);
    const problems = Object.values(validateProduct(product, getRows()));
    if (!photos.some(photo => photo.main)) problems.push('Choose a main photo.');
    const names = colors();
    if (photos.some(photo => !photo.main && !photo.colors.length)) problems.push('Every photo must be the main photo or assigned to a color. Remove unused photos.');
    if (photos.some(photo => photo.colors.some(color => !names.includes(color)))) problems.push('A photo is assigned to a removed color. Update its color assignment.');
    const assignments = photos.flatMap(photo => photo.colors);
    if (new Set(assignments).size !== assignments.length) problems.push('Use only one photo per color.');
    if (problems.length) throw new Error(problems.join(' '));
    return product;
  }

  function updatePreview() {
    preview.replaceChildren();
    preview.append(element('h4', fields.title.value || 'Your product preview'));
    const main = photos.find(photo => photo.main);
    if (main) {
      const image = element('img');
      image.src = main.previewUrl;
      image.alt = fields.title.value || 'Main product photo';
      image.style.maxWidth = '240px';
      image.style.maxHeight = '200px';
      preview.append(image);
    }
    const base = Number(fields.price.value);
    const discount = Number(fields.discount.value);
    if (fields.price.value && Number.isFinite(base)) {
      if (discount > 0 && discount <= 100) {
        const price = element('p');
        const originalPrice = element('s', `$${base.toFixed(2)}`);
        price.append(originalPrice, element('span', ` $${(base * (1 - discount / 100)).toFixed(2)} (${discount}% off)`));
        preview.append(price);
      } else {
        preview.append(element('p', `$${base.toFixed(2)}`));
      }
    } else {
      preview.append(element('p', 'Enter a price'));
    }
    if (fields.tag.value) preview.append(element('span', fields.tag.value, 'creator-preview-tag'));
    if (fields.status.value) preview.append(element('p', `Availability: ${fields.status.value.replaceAll('-', ' ')}`, 'creator-preview-status'));
    preview.append(element('p', fields.description.value));
    preview.append(element('p', `Colors: ${fields.colors.value || 'None'} · Pickups: ${fields.pickup_configs.value || 'None'}`));
  }

  function renderPhotos() {
    controls = controls.filter(control => !photoControls.includes(control));
    const staticCount = controls.length;
    photoList.replaceChildren();
    photos.forEach((photo, index) => {
      const card = element('div', null, 'creator-photo');
      const image = element('img');
      image.src = photo.previewUrl;
      image.alt = photo.name;
      image.style.width = '110px';
      image.style.height = '90px';
      image.style.objectFit = 'contain';
      card.append(image, element('p', photo.name));
      if (photo.blob) card.append(element('p',
        `${photo.originalWidth} × ${photo.originalHeight} → ${photo.width} × ${photo.height}; ${Math.ceil(photo.originalSize / 1024)} → ${Math.ceil(photo.blob.size / 1024)} KB`));
      button(photo.main ? 'Main photo ✓' : 'Use as main photo', () => {
        if (busy || !allowed()) return;
        photos.forEach(item => { item.main = item === photo; });
        invalidate();
        renderPhotos();
      }, card);
      for (const color of colors()) {
        const label = element('label', ` ${color}`);
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.checked = photo.colors.includes(color);
        checkbox.setAttribute('aria-label', `Use ${photo.name} for ${color}`);
        checkbox.addEventListener('change', () => {
          if (busy || !allowed()) return;
          photos.forEach(item => { item.colors = item.colors.filter(name => name !== color); });
          if (checkbox.checked) photo.colors.push(color);
          invalidate();
          renderPhotos();
        });
        label.prepend(checkbox);
        card.append(label);
        controls.push(checkbox);
      }
      if (photo.colors.some(color => !colors().includes(color))) {
        button('Clear removed color assignments', () => {
          if (busy || !allowed()) return;
          photo.colors = photo.colors.filter(color => colors().includes(color));
          invalidate();
          renderPhotos();
        }, card);
      }
      for (const [text, offset] of [['Move earlier', -1], ['Move later', 1]]) {
        const move = button(text, () => {
          if (busy || !allowed()) return;
          const next = index + offset;
          [photos[index], photos[next]] = [photos[next], photos[index]];
          invalidate();
          renderPhotos();
        }, card);
        move.disabled = index + offset < 0 || index + offset >= photos.length || busy;
      }
      button('Remove photo', () => {
        if (busy || !allowed()) return;
        release(photo);
        photos = photos.filter(item => item !== photo);
        invalidate();
        renderPhotos();
      }, card);
      photoList.append(card);
    });
    photoControls = controls.slice(staticCount);
  }

  async function addPhotos(files) {
    if (!draft || busy || !allowed() || !files.length) return;
    const token = generation;
    const prepared = [];
    try {
      checkPhotoBatch(files, photos, photoOptions);
      const options = { ...photoOptions, urlApi, maxDimension: Number(resize.value), quality: Number(quality.value), keepOriginal: original.checked };
      setBusy(true);
      message('Preparing photos…');
      for (const file of files) {
        const photo = await preparePhoto(file, options);
        prepared.push(photo);
        if (token !== generation || !isAllowed()) {
          if (token === generation) clear();
          prepared.forEach(release);
          return;
        }
      }
      const totalBytes = [...photos, ...prepared].reduce((sum, photo) => sum + (photo.blob?.size || 0), 0);
      if (totalBytes > (photoOptions.maxTotalBytes ?? PHOTO_LIMITS.maxTotalBytes)) throw new Error('The processed photos exceed the total size limit.');
      prepared.forEach(photo => {
        photo.main = !photos.some(item => item.main);
        photo.colors = [];
        photos.push(photo);
      });
      invalidate();
      renderPhotos();
    } catch (error) {
      prepared.forEach(release);
      if (token === generation) {
        if (!isAllowed()) clear();
        else message(error.message, true);
      }
    } finally {
      if (token === generation) {
        input.value = '';
        setBusy(false);
        renderPhotos();
      }
    }
  }

  function review() {
    if (busy || !allowed()) return;
    try {
      const product = validate();
      reviewed = true;
      message('');
      reviewPanel.replaceChildren(element('h4', 'Review before saving'));
      for (const key of SHOP_COLUMNS.filter(key => !['img', 'color_images'].includes(key))) {
        reviewPanel.append(element('p', `${key.replaceAll('_', ' ')}: ${product[key] || '—'}`));
      }
      reviewPanel.append(element('p', `${photos.length} main/color photo(s). This only saves to the list; publishing is a separate action.`));
      reviewPanel.hidden = false;
      saveButton.disabled = false;
      saveButton.focus();
      changed();
    } catch (error) { message(error.message, true); }
  }

  async function save() {
    if (busy || !reviewed || !allowed()) return;
    const token = generation;
    let staged = [];
    try {
      const product = validate(true);
      staged = photos.filter(photo => photo.blob && (photo.main || photo.colors.length));
      const payload = staged.map(photo => ({ path: photo.path, blob: photo.blob, previewUrl: photo.previewUrl, state: 'pending' }));
      // Transfer before callback: parent may synchronously call clear/open.
      staged.forEach(photo => { photo.transferred = true; });
      setBusy(true);
      await onSave(product, payload);
      if (token === generation) clear();
    } catch (error) {
      staged.forEach(photo => { photo.transferred = false; });
      if (token === generation) {
        message(error.message || 'Saving failed. Please try again.', true);
        setBusy(false);
      } else {
        staged.forEach(release);
      }
    }
  }

  function open(template = null) {
    if (busy || !allowed()) return false;
    if (draft && !window.confirm('Discard this unsaved product draft?')) return false;
    clear();
    draft = { ...(template || {}) };
    autoId = !template;
    photos = templatePhotos(template);
    controls = [];
    photoControls = [];
    root = element('section', null, 'product-creator');
    root.setAttribute('aria-label', template ? 'Duplicate product creator' : 'New product creator');
    root.append(element('h3', template ? 'Create a duplicate product' : 'Create a product'));
    const fieldGroup = element('div', null, 'creator-fields');
    fieldGroup.style.display = 'grid';
    fieldGroup.style.gridTemplateColumns = 'repeat(auto-fit, minmax(220px, 1fr))';
    fieldGroup.style.gap = '12px';
    const labels = {
      title: 'Title', id: 'Product ID (unique slug)', price: 'Price', description: 'Description',
      category: 'Category slug', subcategory: 'Subcategory slug', handedness: 'Handedness',
      status: 'Availability', tag: 'Tag', discount: 'Discount (%)', custom_color_fee: 'Custom color fee',
      colors: 'Colors (comma-separated names)', pickup_configs: 'Pickup configurations (comma-separated)'
    };
    for (const [name, labelText] of Object.entries(labels)) {
      const label = element('label', labelText, 'creator-field');
      const choices = name === 'handedness' ? HANDEDNESS_VALUES : name === 'status' ? STATUS_VALUES : null;
      const field = element(choices ? 'select' : name === 'description' ? 'textarea' : 'input');
      field.name = name;
      field.setAttribute('aria-label', labelText);
      if (choices) for (const value of choices) {
        const option = element('option', value || 'Not specified');
        option.value = value;
        field.append(option);
      }
      field.value = name === 'id' ? uniqueProductId(template?.id || template?.title || '', [...getRows(), ...(template ? [template] : [])]) :
        ['colors', 'pickup_configs'].includes(name) ? String(draft[name] || '').split('|').join(', ') : String(draft[name] || '');
      if (['price', 'discount', 'custom_color_fee'].includes(name)) {
        field.type = 'number';
        field.min = '0';
        field.step = '0.01';
        field.max = name === 'discount' ? '100' : name === 'custom_color_fee' ? '10000' : '100000';
      }
      field.addEventListener('input', () => {
        if (busy || !allowed()) return;
        if (name === 'id') autoId = false;
        if (name === 'title' && autoId) fields.id.value = uniqueProductId(field.value, getRows());
        invalidate();
        if (name === 'colors') renderPhotos();
      });
      if (['category', 'subcategory', 'pickup_configs'].includes(name)) {
        const list = element('datalist');
        list.id = `creator-${name}-${generation}`;
        const values = getRows().flatMap(row => name === 'pickup_configs' ?
          String(row[name] || '').split('|').map(value => value.trim()) : [row[name]]).filter(Boolean);
        for (const value of [...new Set(values)]) {
          const option = element('option');
          option.value = value;
          list.append(option);
        }
        field.setAttribute('list', list.id);
        label.append(list);
      }
      label.append(field);
      fieldGroup.append(label);
      fields[name] = field;
    }
    root.append(fieldGroup);
    const photoSection = element('section', null, 'creator-photos');
    photoSection.append(element('h4', 'Main and color photos'));
    photoSection.append(element('p', 'JPEG, PNG or WebP only. Each photo must be the main image or assigned to a color; there is no separate gallery.'));
    const limits = { ...PHOTO_LIMITS, ...photoOptions };
    photoSection.append(element('p', `Up to ${limits.maxCount} photos when adding files, including retained template photos; ${Math.floor(limits.maxFileBytes / 1048576)} MB each new file, ${Math.floor(limits.maxTotalBytes / 1048576)} MB total new files.`));
    const optionField = (text, type, value) => {
      const label = element('label', text);
      const field = element('input');
      field.type = type;
      field.value = value;
      field.setAttribute('aria-label', text);
      label.append(field);
      photoSection.append(label);
      controls.push(field);
      return field;
    };
    resize = optionField('Maximum image dimension (px)', 'number', String(limits.maxDimension));
    resize.min = '1';
    quality = optionField('Image quality (0.1–1)', 'number', String(limits.quality));
    quality.min = '0.1';
    quality.max = '1';
    quality.step = '0.05';
    original = optionField('Keep original files (no resize)', 'checkbox', '');
    photoSection.append(element('p', 'Resize settings apply to newly added photos. Transparency is preserved for PNG/WebP.'));
    const zone = element('div', 'Drop photos here or use the picker.', 'creator-dropzone');
    zone.addEventListener('dragover', event => { event.preventDefault(); });
    zone.addEventListener('drop', event => {
      event.preventDefault();
      void addPhotos([...event.dataTransfer.files]);
    });
    input = element('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/jpeg,image/png,image/webp';
    input.setAttribute('aria-label', 'Choose main and color photos');
    input.addEventListener('change', () => { void addPhotos([...input.files]); });
    controls.push(input);
    zone.append(input);
    photoList = element('div');
    photoSection.append(zone, photoList);
    root.append(photoSection);
    preview = element('section', null, 'creator-preview');
    preview.setAttribute('aria-label', 'Live product preview');
    preview.setAttribute('aria-live', 'polite');
    errors = element('p', '', 'creator-errors');
    errors.setAttribute('role', 'alert');
    errors.setAttribute('tabindex', '-1');
    reviewPanel = element('section', null, 'creator-review');
    reviewPanel.hidden = true;
    const actions = element('div', null, 'creator-actions');
    reviewButton = button('Review product', review, actions);
    saveButton = button('Save to list', () => { void save(); }, actions);
    saveButton.disabled = true;
    discardButton = button('Discard draft', () => {
      if (busy || !allowed()) return;
      if (window.confirm('Discard this unsaved product draft?')) clear();
    }, actions);
    root.append(preview, errors, reviewPanel, actions);
    container.hidden = false;
    container.replaceChildren(root);
    renderPhotos();
    updatePreview();
    fields.title.focus();
    changed();
    return true;
  }

  return { open, clear, hasDraft: () => !!draft, isBusy: () => busy };
}
