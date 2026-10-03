// Remembers non-sensitive shop/gallery UI choices (selected options and
// colors, gallery photo, category, subcategory, custom-color drafts) per
// cart scope, so they survive reloads without leaking between visitors:
//   * guest ("guest" scope, including anonymous guest-checkout sessions)
//     keeps using the original localStorage keys passed in `guestKeys`
//   * each signed-in account uses its own keys:
//       jgv3d_prefs_v1:{uid}:{name}
//   * while sign-in is still being checked ("pending") values live only in
//     memory and are discarded when the scope is known.
// Nothing is ever copied between guest and account keys or between
// accounts. Account keys are kept on sign-out so they return next sign-in.
// Loaded as a classic script; exposes window.JGV3DPrefs.
(function (global) {
  'use strict';

  var PREFIX = 'jgv3d_prefs_v1:';
  var UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var MAX_MAP_ENTRIES = 200;
  var MAX_STRING_LENGTH = 50000;

  function accountUid(scopeKey) {
    if (typeof scopeKey !== 'string' || scopeKey.indexOf('account:') !== 0) return null;
    var uid = scopeKey.slice('account:'.length);
    return UID_RE.test(uid) ? uid : null;
  }

  function accountKey(uid, name) {
    return PREFIX + uid + ':' + name;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function defaultStorage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  function createScopedPrefs(options) {
    var opts = options || {};
    var storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    var guestKeys = opts.guestKeys || {};
    var scopeKey = 'pending';
    var memory = {};

    function keyFor(name) {
      if (scopeKey === 'guest') return Object.prototype.hasOwnProperty.call(guestKeys, name) ? guestKeys[name] : null;
      var uid = accountUid(scopeKey);
      return uid ? accountKey(uid, name) : null;
    }

    // Returns true when the scope actually changed (callers re-render).
    function setScope(next) {
      var value = typeof next === 'string' ? next : 'pending';
      if (value === scopeKey) return false;
      scopeKey = value;
      memory = {};
      return true;
    }

    function getString(name) {
      var key = keyFor(name);
      if (!key || !storage) return Object.prototype.hasOwnProperty.call(memory, name) ? memory[name] : null;
      try {
        var value = storage.getItem(key);
        return typeof value === 'string' ? value : null;
      } catch (e) {
        return null;
      }
    }

    function setString(name, value) {
      var text = String(value);
      var key = keyFor(name);
      if (!key || !storage) {
        memory[name] = text;
        return false;
      }
      if (accountUid(scopeKey) && text.length > MAX_STRING_LENGTH) return false;
      try {
        storage.setItem(key, text);
        return true;
      } catch (e) {
        return false; // storage full or blocked: keep working without saving
      }
    }

    function getMap(name) {
      var raw = getString(name);
      if (raw === null) return {};
      try {
        var parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    // Account maps are capped (oldest entries dropped first). Guest maps keep
    // their original, uncapped behaviour.
    function setMap(name, map) {
      var next = isPlainObject(map) ? map : {};
      if (accountUid(scopeKey)) {
        var keys = Object.keys(next);
        if (keys.length > MAX_MAP_ENTRIES) {
          var trimmed = {};
          keys.slice(keys.length - MAX_MAP_ENTRIES).forEach(function (k) { trimmed[k] = next[k]; });
          next = trimmed;
        }
      }
      var text;
      try { text = JSON.stringify(next); } catch (e) { return false; }
      return setString(name, text);
    }

    // Drops entries for products that no longer exist (account scope only).
    function pruneMap(name, validKeys) {
      if (!accountUid(scopeKey)) return false;
      var valid = new Set(Array.from(validKeys || [], String));
      var map = getMap(name);
      var changed = false;
      Object.keys(map).forEach(function (k) {
        if (!valid.has(k)) { delete map[k]; changed = true; }
      });
      return changed ? setMap(name, map) : false;
    }

    return {
      setScope: setScope,
      getScopeKey: function () { return scopeKey; },
      isGuest: function () { return scopeKey === 'guest'; },
      isAccount: function () { return Boolean(accountUid(scopeKey)); },
      getString: getString,
      setString: setString,
      getMap: getMap,
      setMap: setMap,
      pruneMap: pruneMap
    };
  }

  global.JGV3DPrefs = {
    PREFIX: PREFIX,
    MAX_MAP_ENTRIES: MAX_MAP_ENTRIES,
    accountUid: accountUid,
    accountKey: accountKey,
    createScopedPrefs: createScopedPrefs
  };
})(typeof window !== 'undefined' ? window : globalThis);
