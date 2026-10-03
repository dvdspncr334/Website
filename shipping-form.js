// Shared shipping-address form fields used by checkout (cart.html) and the
// account Settings tab (login.html). Builds labelled, accessible inputs from
// SHIPPING_FIELDS and never stores anything in browser storage.
import { SHIPPING_FIELDS, COUNTRY_SUGGESTIONS, normalizeShipping } from './account-data.js';

export function createShippingForm(container, { idPrefix }) {
  const doc = container.ownerDocument || document;
  const inputs = {};
  const errorEls = {};
  container.textContent = '';
  const grid = doc.createElement('div');
  grid.className = 'shipping-grid';

  const listId = `${idPrefix}-countries`;
  const datalist = doc.createElement('datalist');
  datalist.id = listId;
  for (const country of COUNTRY_SUGGESTIONS) {
    const option = doc.createElement('option');
    option.value = country;
    datalist.append(option);
  }

  for (const field of SHIPPING_FIELDS) {
    const id = `${idPrefix}-${field.name}`;
    const wrapper = doc.createElement('div');
    wrapper.className = `shipping-field${field.wide ? ' shipping-field-wide' : ''}`;
    const label = doc.createElement('label');
    label.htmlFor = id;
    label.textContent = field.label;
    if (field.required) {
      const star = doc.createElement('span');
      star.className = 'shipping-required';
      star.setAttribute('aria-hidden', 'true');
      star.textContent = ' *';
      label.append(star);
    }
    const input = doc.createElement(field.multiline ? 'textarea' : 'input');
    input.id = id;
    input.name = field.name;
    if (!field.multiline) input.type = field.type || 'text';
    else input.rows = 3;
    input.maxLength = field.max;
    input.autocomplete = field.autocomplete ? `shipping ${field.autocomplete}` : 'off';
    if (field.required) {
      input.required = true;
      input.setAttribute('aria-required', 'true');
    }
    if (field.list) input.setAttribute('list', listId);
    const describedBy = [];
    wrapper.append(label, input);
    if (field.hint) {
      const hint = doc.createElement('p');
      hint.className = 'shipping-hint';
      hint.id = `${id}-hint`;
      hint.textContent = field.hint;
      wrapper.append(hint);
      describedBy.push(hint.id);
    }
    const error = doc.createElement('p');
    error.className = 'shipping-error';
    error.id = `${id}-error`;
    error.hidden = true;
    wrapper.append(error);
    describedBy.push(error.id);
    input.setAttribute('aria-describedby', describedBy.join(' '));
    input.addEventListener('input', () => setFieldError(field.name, ''));
    inputs[field.name] = input;
    errorEls[field.name] = error;
    grid.append(wrapper);
  }
  container.append(grid, datalist);

  function setFieldError(name, message) {
    const input = inputs[name];
    const error = errorEls[name];
    error.textContent = message || '';
    error.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function clearErrors() {
    for (const name of Object.keys(inputs)) setFieldError(name, '');
  }

  return {
    read() {
      const raw = {};
      for (const [name, input] of Object.entries(inputs)) raw[name] = input.value;
      return normalizeShipping(raw);
    },
    fill(data) {
      const shipping = normalizeShipping(data);
      for (const [name, input] of Object.entries(inputs)) input.value = shipping[name];
      clearErrors();
    },
    clear() {
      for (const input of Object.values(inputs)) input.value = '';
      clearErrors();
    },
    // Shows messages next to fields and focuses the first invalid one.
    showErrors(errors) {
      clearErrors();
      let first = null;
      for (const field of SHIPPING_FIELDS) {
        if (errors[field.name]) {
          setFieldError(field.name, errors[field.name]);
          if (!first) first = inputs[field.name];
        }
      }
      if (first) first.focus();
      return Boolean(first);
    },
    setDisabled(disabled) {
      for (const input of Object.values(inputs)) input.disabled = disabled;
    },
    focusFirst() {
      inputs[SHIPPING_FIELDS[0].name].focus();
    }
  };
}
