// Remembers non-sensitive shop/gallery UI choices (selected options and
// colors, gallery photo, category, subcategory, search, sort, reading
// position, custom-color drafts) per cart scope, without leaking between
// visitors:
//   * guest ("guest" scope, including anonymous guest-checkout sessions)
//     keeps using the original localStorage keys passed in `guestKeys`
//     (names without a guest key are kept in memory for this page only)
//   * pages created with `cloudDoc` ('shop' or 'gallery') sync each signed-in
//     account's choices across devices through the private Firestore
//     document users/{uid}/preferences/{cloudDoc} (see prefs-firebase.js and
//     firestore.rules). This browser keeps an account-specific cache
//     (jgv3d_prefs_cache_v2:{uid}:{cloudDoc}) of the last synced copy plus
//     any unsent changes, so choices still work offline.
//   * pages without `cloudDoc` keep each account's choices in this browser
//     only: jgv3d_prefs_v1:{uid}:{name}. These per-browser keys are also
//     the one-time migration source when an account has no cloud document.
//   * while sign-in is still being checked ("pending") values live only in
//     memory and are discarded when the scope is known.
// Nothing is ever copied between guest and account keys or between
// accounts. Account keys are kept on sign-out so they return next sign-in.
// Loaded as a classic script; exposes window.JGV3DPrefs.
(function (global) {
  'use strict';

  var PREFIX = 'jgv3d_prefs_v1:';
  var CACHE_PREFIX = 'jgv3d_prefs_cache_v2:';
  var UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  var MAX_MAP_ENTRIES = 200;
  var MAX_STRING_LENGTH = 50000;

  // ---- Cloud document layout (keep in sync with firestore.rules) ----
  var SCHEMA_VERSION = 1;
  var MAX_CHANGED_PER_WRITE = 10;
  var MAX_KEY_LENGTH = 200;
  var MAX_CACHE_LENGTH = 400000;
  var LIMITS = { option: 100, draft: 160, index: 99, anchor: 200 };
  var OPTION_FIELDS = ['color', 'pickup', 'handedness'];
  var VIEW_FIELDS = { category: 100, subcategory: 100, search: 100, sort: 40 };
  var MAP_FIELDS = {
    shop: { options: 'options', drafts: 'text' },
    gallery: { images: 'index' }
  };
  // Page pref name -> location in the cloud document.
  var CLOUD_DOCS = {
    shop: {
      shop_options: ['map', 'options'],
      shop_drafts: ['map', 'drafts'],
      shop_category: ['view', 'category'],
      shop_subcategory: ['view', 'subcategory'],
      shop_search: ['view', 'search'],
      shop_sort: ['view', 'sort'],
      shop_scroll: ['scroll']
    },
    gallery: {
      gallery_images: ['map', 'images'],
      gallery_category: ['view', 'category'],
      gallery_subcategory: ['view', 'subcategory'],
      gallery_search: ['view', 'search'],
      gallery_sort: ['view', 'sort'],
      gallery_scroll: ['scroll']
    }
  };
  var SAVE_DELAY_MS = 800;
  var SAVE_MAX_WAIT_MS = 4000;
  var RETRY_BASE_MS = 2000;
  var RETRY_MAX_MS = 60000;
  // Errors that retrying automatically won't fix (rules not published,
  // rejected data). Changes stay on this device until the user retries.
  var PERMANENT_CODES = ['permission-denied', 'invalid-argument', 'unauthenticated', 'failed-precondition', 'out-of-range'];

  function accountUid(scopeKey) {
    if (typeof scopeKey !== 'string' || scopeKey.indexOf('account:') !== 0) return null;
    var uid = scopeKey.slice('account:'.length);
    return UID_RE.test(uid) ? uid : null;
  }

  function accountKey(uid, name) {
    return PREFIX + uid + ':' + name;
  }

  function cacheKey(uid, doc) {
    return CACHE_PREFIX + uid + ':' + doc;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function defaultStorage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  // Product/gallery keys become Firestore field names: bounded, non-empty
  // and never a reserved __name__ (which also rules out __proto__).
  function isValidEntryKey(key) {
    return typeof key === 'string' && key.length >= 1 && key.length <= MAX_KEY_LENGTH && !/^__.*__$/.test(key);
  }

  function unit(value) {
    if (typeof value !== 'number' || !isFinite(value)) return null;
    return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  }

  function cleanEntry(kind, value) {
    if (kind === 'options') {
      if (!isPlainObject(value)) return undefined;
      var out = {};
      var any = false;
      OPTION_FIELDS.forEach(function (field) {
        if (typeof value[field] === 'string' && value[field].length <= LIMITS.option) {
          out[field] = value[field];
          any = true;
        }
      });
      return any ? out : undefined;
    }
    if (kind === 'text') {
      return typeof value === 'string' && value.length >= 1 ? value.slice(0, LIMITS.draft) : undefined;
    }
    if (kind === 'index') {
      return typeof value === 'number' && Math.floor(value) === value && value >= 0 && value <= LIMITS.index ? value : undefined;
    }
    return undefined;
  }

  // Reading position: a stable item anchor, the offset into that item (0..1
  // of its height) and a whole-page ratio used when the anchor is missing.
  function cleanScroll(value) {
    if (!isPlainObject(value)) return undefined;
    var ratio = unit(value.ratio);
    if (ratio === null) return undefined;
    var anchor = typeof value.anchor === 'string' && isValidEntryKey(value.anchor) ? value.anchor : '';
    var offset = anchor ? unit(value.offset) : 0;
    return { anchor: anchor, offset: offset === null ? 0 : offset, ratio: ratio };
  }

  function emptyState(doc) {
    var state = { view: {} };
    Object.keys(MAP_FIELDS[doc]).forEach(function (field) { state[field] = {}; });
    return state;
  }

  // Validates data read from Firestore or the local cache. Invalid or
  // outdated values are dropped (never written back).
  function sanitizeState(doc, data) {
    var src = isPlainObject(data) ? data : {};
    var state = emptyState(doc);
    var maps = MAP_FIELDS[doc];
    Object.keys(maps).forEach(function (field) {
      if (!isPlainObject(src[field])) return;
      var count = 0;
      Object.keys(src[field]).forEach(function (key) {
        if (count >= MAX_MAP_ENTRIES || !isValidEntryKey(key)) return;
        var value = cleanEntry(maps[field], src[field][key]);
        if (value !== undefined) {
          state[field][key] = value;
          count += 1;
        }
      });
    });
    if (isPlainObject(src.view)) {
      Object.keys(VIEW_FIELDS).forEach(function (field) {
        var value = src.view[field];
        if (typeof value === 'string' && value.length <= VIEW_FIELDS[field]) state.view[field] = value;
      });
    }
    var scroll = cleanScroll(src.scroll);
    if (scroll) state.scroll = scroll;
    return state;
  }

  // A change is {path, value} or {path, del: true}. Returns a cleaned copy,
  // or null when the path/value isn't part of the document layout.
  function cleanOp(doc, op) {
    if (!op || !Array.isArray(op.path)) return null;
    var p = op.path;
    var del = op.del === true;
    if (p.length === 2 && p[0] === 'view' && typeof p[1] === 'string' && hasOwn(VIEW_FIELDS, p[1])) {
      if (del || typeof op.value !== 'string' || op.value.length > VIEW_FIELDS[p[1]]) return null;
      return { path: ['view', p[1]], value: op.value };
    }
    if (p.length === 1 && p[0] === 'scroll') {
      var scroll = del ? undefined : cleanScroll(op.value);
      return scroll ? { path: ['scroll'], value: scroll } : null;
    }
    var maps = MAP_FIELDS[doc];
    if (typeof p[0] !== 'string' || !hasOwn(maps, p[0]) || !isValidEntryKey(p[1])) return null;
    var kind = maps[p[0]];
    if (p.length === 2) {
      if (del) return { path: [p[0], p[1]], del: true };
      var value = cleanEntry(kind, op.value);
      return value === undefined ? null : { path: [p[0], p[1]], value: value };
    }
    if (p.length === 3 && kind === 'options' && OPTION_FIELDS.indexOf(p[2]) >= 0) {
      if (del) return { path: [p[0], p[1], p[2]], del: true };
      if (typeof op.value !== 'string' || op.value.length > LIMITS.option) return null;
      return { path: [p[0], p[1], p[2]], value: op.value };
    }
    return null;
  }

  function pathKey(path) {
    return JSON.stringify(path);
  }

  function isPrefix(prefix, path) {
    if (prefix.length > path.length) return false;
    for (var i = 0; i < prefix.length; i += 1) if (prefix[i] !== path[i]) return false;
    return true;
  }

  function applyOp(state, op) {
    var target = state;
    for (var i = 0; i < op.path.length - 1; i += 1) {
      var seg = op.path[i];
      if (!isPlainObject(target[seg])) {
        if (op.del) return;
        target[seg] = {};
      }
      target = target[seg];
    }
    var last = op.path[op.path.length - 1];
    if (op.del) delete target[last];
    else target[last] = clone(op.value);
  }

  function errorCode(error) {
    var code = error && typeof error.code === 'string' ? error.code : '';
    return code.indexOf('firestore/') === 0 ? code.slice('firestore/'.length) : code;
  }

  function describeSyncError(code) {
    if (code === 'permission-denied' || code === 'unauthenticated') {
      return 'Your choices couldn\'t sync to your account (permission denied). They\'re kept on this device.';
    }
    if (code === 'backend-unavailable') {
      return 'Choice syncing couldn\'t start. Your choices are kept on this device.';
    }
    return 'Your choices couldn\'t sync to your account. They\'re kept on this device.';
  }

  function createScopedPrefs(options) {
    var opts = options || {};
    var storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    var guestKeys = opts.guestKeys || {};
    var cloudDoc = typeof opts.cloudDoc === 'string' && hasOwn(CLOUD_DOCS, opts.cloudDoc) ? opts.cloudDoc : null;
    var spec = cloudDoc ? CLOUD_DOCS[cloudDoc] : {};
    var timers = opts.timers || {
      setTimeout: function (fn, ms) { return global.setTimeout(fn, ms); },
      clearTimeout: function (id) { global.clearTimeout(id); }
    };
    var now = opts.now || function () { return Date.now(); };
    var isOnline = opts.isOnline || function () {
      try { return !global.navigator || global.navigator.onLine !== false; } catch (e) { return true; }
    };
    var scopeKey = 'pending';
    var memory = {};

    // Cloud sync state. `session` exists only while a signed-in account is
    // the scope on a cloud page; it is replaced on every scope change and
    // every async callback checks it is still the current one.
    var cloudLoader = null;
    var backendPromise = null;
    var backend = null;
    var backendError = null;
    var session = null;
    var opVersion = 0;
    var remoteListeners = [];
    var syncListeners = [];
    var syncState = { mode: 'local', status: 'idle', message: '', canRetry: false, pending: 0 };

    function keyFor(name) {
      if (scopeKey === 'guest') return hasOwn(guestKeys, name) ? guestKeys[name] : null;
      var uid = accountUid(scopeKey);
      return uid ? accountKey(uid, name) : null;
    }

    function readStorage(key) {
      if (!storage) return null;
      try {
        var value = storage.getItem(key);
        return typeof value === 'string' ? value : null;
      } catch (e) {
        return null;
      }
    }

    // ---------------- cloud sync engine ----------------

    function notifySync() {
      var next;
      var s = session;
      if (!s) {
        next = { mode: 'local', status: 'idle', message: '', canRetry: false, pending: 0 };
      } else {
        var pending = s.pending.size;
        var permanent = (s.lastError && s.lastError.permanent) ? s.lastError : (s.listenError && s.listenError.permanent ? s.listenError : null);
        if (backendError || permanent) {
          next = { status: 'error', message: describeSyncError(backendError ? 'backend-unavailable' : permanent.code), canRetry: true };
        } else if (!isOnline() || s.fromCache || s.lastError || s.listenError) {
          next = {
            status: 'offline',
            message: pending
              ? 'Offline: your latest choices are kept on this device and will sync when you reconnect.'
              : 'Offline: showing the choices saved on this device.',
            canRetry: Boolean(s.lastError || s.listenError)
          };
        } else if (!s.serverSeen && !s.ready) {
          next = { status: 'loading', message: 'Loading your saved choices…', canRetry: false };
        } else if (s.inFlight || pending || s.creating) {
          next = { status: 'saving', message: 'Saving your choices to your account…', canRetry: false };
        } else {
          next = { status: 'synced', message: 'Choices synced to your account.', canRetry: false };
        }
        next.mode = 'cloud';
        next.pending = pending;
      }
      if (JSON.stringify(next) === JSON.stringify(syncState)) return;
      syncState = next;
      syncListeners.slice().forEach(function (listener) {
        try { listener(Object.assign({}, syncState)); } catch (e) { /* listener errors don't stop syncing */ }
      });
    }

    function emitRemote(event) {
      remoteListeners.slice().forEach(function (listener) {
        try { listener(event); } catch (e) { /* ignore */ }
      });
    }

    function recompute(s) {
      var state = clone(s.base || s.provisional || emptyState(cloudDoc));
      s.pending.forEach(function (op) { applyOp(state, op); });
      Object.keys(MAP_FIELDS[cloudDoc]).forEach(function (field) {
        if (!isPlainObject(state[field])) state[field] = {};
      });
      if (!isPlainObject(state.view)) state.view = {};
      s.merged = state;
    }

    function persist(s) {
      if (!storage || s !== session) return;
      var pending = [];
      s.pending.forEach(function (op) {
        if (op.migration) return; // only kept once the cloud doc is known to be new
        pending.push(op.del ? { p: op.path, d: 1 } : { p: op.path, v: op.value });
      });
      try {
        var text = JSON.stringify({ v: 2, migrated: s.migrated, base: s.base, pending: pending });
        if (text.length <= MAX_CACHE_LENGTH) storage.setItem(cacheKey(s.uid, cloudDoc), text);
      } catch (e) {
        // storage full or blocked: keep syncing without the offline copy
      }
    }

    function loadCache(uid) {
      var result = { base: null, pending: [], migrated: false };
      var raw = readStorage(cacheKey(uid, cloudDoc));
      if (raw === null) return result;
      try {
        var parsed = JSON.parse(raw);
        if (!isPlainObject(parsed) || parsed.v !== 2) return result;
        result.migrated = parsed.migrated === true;
        result.base = isPlainObject(parsed.base) ? sanitizeState(cloudDoc, parsed.base) : null;
        if (Array.isArray(parsed.pending)) {
          parsed.pending.forEach(function (item) {
            if (!isPlainObject(item)) return;
            var op = cleanOp(cloudDoc, item.d === 1 ? { path: item.p, del: true } : { path: item.p, value: item.v });
            if (op) result.pending.push(op);
          });
        }
      } catch (e) {
        // corrupt cache: ignore it
      }
      return result;
    }

    // Same-uid choices saved by the browser-only version (v1 keys).
    function readLegacy(uid) {
      var data = {};
      var found = false;
      Object.keys(spec).forEach(function (name) {
        var target = spec[name];
        if (target[0] !== 'map' && !(target[0] === 'view' && (target[1] === 'category' || target[1] === 'subcategory'))) return;
        var raw = readStorage(accountKey(uid, name));
        if (raw === null) return;
        if (target[0] === 'map') {
          try {
            var parsed = JSON.parse(raw);
            if (isPlainObject(parsed)) { data[target[1]] = parsed; found = true; }
          } catch (e) { /* ignore corrupt legacy data */ }
        } else {
          data.view = data.view || {};
          data.view[target[1]] = raw;
          found = true;
        }
      });
      return found ? sanitizeState(cloudDoc, data) : null;
    }

    function stateToOps(state) {
      var ops = [];
      var maps = MAP_FIELDS[cloudDoc];
      Object.keys(maps).forEach(function (field) {
        Object.keys(state[field] || {}).forEach(function (key) {
          var value = state[field][key];
          if (maps[field] === 'options') {
            Object.keys(value).forEach(function (f) { ops.push({ path: [field, key, f], value: value[f] }); });
          } else {
            ops.push({ path: [field, key], value: value });
          }
        });
      });
      return ops;
    }

    function putOp(s, op, extra) {
      var key = pathKey(op.path);
      // A change replaces any queued change to the same, a parent or a
      // child field (Firestore can't write both in one update).
      Array.from(s.pending.keys()).forEach(function (k) {
        var other = s.pending.get(k);
        if (k === key || isPrefix(other.path, op.path) || isPrefix(op.path, other.path)) s.pending.delete(k);
      });
      opVersion += 1;
      var entry = { path: op.path, value: op.value, del: op.del === true, ver: opVersion };
      if (extra && extra.migration) entry.migration = true;
      s.pending.set(key, entry);
    }

    function enqueue(op) {
      var s = session;
      var cleaned = cleanOp(cloudDoc, op);
      if (!s || !cleaned) return false;
      putOp(s, cleaned);
      recompute(s);
      persist(s);
      scheduleFlush(s);
      notifySync();
      return true;
    }

    function clearTimer(s, name) {
      if (s[name]) {
        timers.clearTimeout(s[name]);
        s[name] = null;
      }
    }

    function scheduleFlush(s, delay) {
      if (s !== session || !s.pending.size) return;
      var t = now();
      if (s.firstDirtyAt === null) s.firstDirtyAt = t;
      var wait = typeof delay === 'number' ? delay : SAVE_DELAY_MS;
      wait = Math.max(0, Math.min(wait, s.firstDirtyAt + SAVE_MAX_WAIT_MS - t));
      clearTimer(s, 'flushTimer');
      s.flushTimer = timers.setTimeout(function () {
        s.flushTimer = null;
        flush(s);
      }, wait);
    }

    function scheduleRetry(s, action) {
      clearTimer(s, 'retryTimer');
      s.retryDelay = Math.min(RETRY_MAX_MS, s.retryDelay ? s.retryDelay * 2 : RETRY_BASE_MS);
      s.retryTimer = timers.setTimeout(function () {
        s.retryTimer = null;
        if (s === session) action();
      }, s.retryDelay);
    }

    // Sends queued changes as one field-level update (at most
    // MAX_CHANGED_PER_WRITE products per write); one write at a time.
    function flush(s) {
      if (s !== session || !backend || !s.ready || s.creating || s.inFlight || !s.pending.size) return;
      if (s.lastError && s.lastError.permanent) return; // wait for Retry
      if (backend.currentUid() !== s.uid) {
        scheduleRetry(s, function () { flush(s); });
        return;
      }
      var maps = MAP_FIELDS[cloudDoc];
      var batch = [];
      var changed = [];
      s.pending.forEach(function (op) {
        var entryKey = hasOwn(maps, op.path[0]) ? op.path[1] : null;
        if (entryKey !== null && changed.indexOf(entryKey) < 0) {
          if (changed.length >= MAX_CHANGED_PER_WRITE) return;
          changed.push(entryKey);
        }
        batch.push(op);
      });
      s.inFlight = true;
      s.firstDirtyAt = null;
      notifySync();
      var payload = batch.map(function (op) {
        return op.del ? { path: op.path.slice(), del: true } : { path: op.path.slice(), value: clone(op.value) };
      });
      Promise.resolve().then(function () {
        return backend.update(s.uid, cloudDoc, payload, changed.slice());
      }).then(function () {
        if (s !== session) return;
        s.inFlight = false;
        s.retryDelay = 0;
        s.lastError = null;
        batch.forEach(function (op) {
          var key = pathKey(op.path);
          var current = s.pending.get(key);
          if (current && current.ver === op.ver) s.pending.delete(key);
        });
        recompute(s);
        persist(s);
        if (s.pending.size) scheduleFlush(s, 0);
        notifySync();
      }, function (error) {
        if (s !== session) return;
        s.inFlight = false;
        var code = errorCode(error);
        if (code === 'not-found') {
          // The document was deleted elsewhere: create it again, keep changes.
          s.ready = false;
          ensureDoc(s);
          return;
        }
        s.lastError = { code: code || 'unknown', permanent: PERMANENT_CODES.indexOf(code) >= 0 };
        if (!s.lastError.permanent) scheduleRetry(s, function () { flush(s); });
        notifySync();
      });
    }

    function removeMigrationOps(s, versions) {
      s.pending.forEach(function (op, key) {
        if (op.migration && versions[key] === op.ver) s.pending.delete(key);
      });
    }

    // Called only after the server says the document doesn't exist. Creates
    // it in a transaction that does nothing if another device created it
    // first. Same-uid legacy choices are migrated only when this device
    // created the document; they never overwrite an existing cloud copy.
    function ensureDoc(s) {
      if (s !== session || s.creating || !backend) return;
      s.creating = true;
      s.ready = false;
      var initial = {};
      var versions = {};
      var before = JSON.stringify(s.merged);
      if (!s.migrated) {
        var legacy = readLegacy(s.uid);
        if (legacy) {
          if (Object.keys(legacy.view).length) initial.view = legacy.view;
          // Migrated entries go before (and never replace) changes made here.
          var existing = Array.from(s.pending.values());
          s.pending = new Map();
          stateToOps(legacy).forEach(function (op) {
            var clash = existing.some(function (other) { return isPrefix(other.path, op.path) || isPrefix(op.path, other.path); });
            if (clash) return;
            putOp(s, op, { migration: true });
            versions[pathKey(op.path)] = opVersion;
          });
          existing.forEach(function (op) { s.pending.set(pathKey(op.path), op); });
        }
      }
      recompute(s);
      notifySync();
      var isCurrent = function () { return s === session && backend.currentUid() === s.uid; };
      Promise.resolve().then(function () {
        return backend.createIfAbsent(s.uid, cloudDoc, clone(initial), isCurrent);
      }).then(function (created) {
        if (s !== session) return;
        s.creating = false;
        s.migrated = true;
        s.retryDelay = 0;
        s.lastError = null;
        if (created) {
          s.pending.forEach(function (op) { delete op.migration; });
        } else {
          removeMigrationOps(s, versions);
        }
        s.ready = true;
        finishLocalChange(s, before);
        scheduleFlush(s, 0);
        notifySync();
      }, function (error) {
        if (s !== session) return;
        s.creating = false;
        removeMigrationOps(s, versions);
        finishLocalChange(s, before);
        var code = errorCode(error);
        s.lastError = { code: code || 'unknown', permanent: PERMANENT_CODES.indexOf(code) >= 0 };
        // A failed check is not "absent": try again later, migrate nothing now.
        if (!s.lastError.permanent) scheduleRetry(s, function () { ensureDoc(s); });
        notifySync();
      });
    }

    function finishLocalChange(s, beforeJson) {
      recompute(s);
      persist(s);
      if (JSON.stringify(s.merged) !== beforeJson) emitRemote({ changed: true, authoritative: false });
    }

    function onSnapshot(s, snap) {
      if (s !== session) return;
      s.listenError = null;
      if (!snap || !snap.exists) {
        if (!snap || snap.fromCache) {
          // Not confirmed by the server: unknown, NOT absent.
          s.fromCache = true;
          notifySync();
          return;
        }
        s.fromCache = false;
        s.docExists = false;
        ensureDoc(s);
        return;
      }
      var before = JSON.stringify(s.merged);
      s.base = sanitizeState(cloudDoc, snap.data);
      s.provisional = null;
      s.docExists = true;
      s.migrated = true; // an existing cloud copy always wins over legacy data
      if (!s.creating) s.ready = true;
      s.fromCache = Boolean(snap.fromCache);
      var authoritative = !s.fromCache && !s.serverSeen;
      if (!s.fromCache) s.serverSeen = true;
      recompute(s);
      persist(s);
      var changed = JSON.stringify(s.merged) !== before;
      if (changed || authoritative) emitRemote({ changed: changed, authoritative: authoritative });
      if (s.pending.size && !s.inFlight) scheduleFlush(s);
      notifySync();
    }

    function onListenError(s, error) {
      if (s !== session) return;
      s.unsubscribe = null;
      var code = errorCode(error);
      s.listenError = { code: code || 'unknown', permanent: PERMANENT_CODES.indexOf(code) >= 0 };
      if (!s.listenError.permanent) scheduleRetry(s, function () { subscribe(s); });
      notifySync();
    }

    function subscribe(s) {
      if (s !== session || !backend || s.unsubscribe) return;
      var failed = false;
      try {
        var unsubscribe = backend.subscribe(s.uid, cloudDoc,
          function (snap) { if (!failed) onSnapshot(s, snap); },
          function (error) { failed = true; onListenError(s, error); });
        if (s === session && !failed) s.unsubscribe = unsubscribe;
        else if (typeof unsubscribe === 'function') unsubscribe();
      } catch (error) {
        onListenError(s, error);
      }
    }

    function ensureBackend(s) {
      if (s !== session) return;
      if (!cloudLoader) {
        notifySync();
        return;
      }
      if (!backendPromise) {
        backendError = null;
        backendPromise = Promise.resolve().then(cloudLoader).then(function (value) {
          backend = value;
          return value;
        });
        backendPromise.catch(function (error) {
          backendPromise = null;
          backendError = error || new Error('unavailable');
          notifySync();
        });
      }
      backendPromise.then(function () { subscribe(s); }, function () { /* reported above */ });
      notifySync();
    }

    function startCloud(uid) {
      var cache = loadCache(uid);
      var s = {
        uid: uid,
        base: cache.base,
        provisional: null,
        merged: null,
        pending: new Map(),
        migrated: cache.migrated,
        ready: false,
        creating: false,
        docExists: null,
        serverSeen: false,
        fromCache: false,
        inFlight: false,
        lastError: null,
        listenError: null,
        unsubscribe: null,
        flushTimer: null,
        retryTimer: null,
        retryDelay: 0,
        firstDirtyAt: null
      };
      session = s;
      cache.pending.forEach(function (op) { putOp(s, op); });
      // Before the cloud answers, show the last synced copy, or this
      // account's browser-only choices on a first visit (display only).
      if (!s.base && !s.migrated) s.provisional = readLegacy(uid);
      recompute(s);
      ensureBackend(s);
    }

    function stopCloud() {
      var s = session;
      if (!s) return;
      session = null; // every pending callback for `s` is now ignored
      if (s.unsubscribe) {
        try { s.unsubscribe(); } catch (e) { /* listener already closed */ }
        s.unsubscribe = null;
      }
      clearTimer(s, 'flushTimer');
      clearTimer(s, 'retryTimer');
      notifySync();
    }

    function retrySync() {
      var s = session;
      if (!s) return;
      clearTimer(s, 'retryTimer');
      s.retryDelay = 0;
      s.lastError = null;
      s.listenError = null;
      if (!backend) {
        backendError = null;
        ensureBackend(s);
        return;
      }
      if (!s.unsubscribe) subscribe(s);
      else if (s.docExists === false && !s.ready) ensureDoc(s);
      if (s.pending.size) scheduleFlush(s, 0);
      notifySync();
    }

    function cloudGetMap(name) {
      var target = spec[name];
      if (target[0] === 'map') return clone(session.merged[target[1]] || {});
      if (target[0] === 'scroll') return clone(session.merged.scroll || {});
      return {};
    }

    function cloudSetMap(name, map) {
      var target = spec[name];
      var merged = session.merged;
      if (target[0] === 'scroll') {
        var scroll = cleanScroll(map);
        if (!scroll) return false;
        if (JSON.stringify(scroll) === JSON.stringify(merged.scroll || null)) return true;
        return enqueue({ path: ['scroll'], value: scroll });
      }
      if (target[0] !== 'map') return false;
      var field = target[1];
      var kind = MAP_FIELDS[cloudDoc][field];
      var current = merged[field] || {};
      var next = isPlainObject(map) ? map : {};
      var ops = [];
      Object.keys(current).forEach(function (key) {
        if (!hasOwn(next, key) || cleanEntry(kind, next[key]) === undefined) ops.push({ path: [field, key], del: true });
      });
      var count = Object.keys(current).length;
      var ok = true;
      Object.keys(next).forEach(function (key) {
        var value = isValidEntryKey(key) ? cleanEntry(kind, next[key]) : undefined;
        if (value === undefined) return;
        var exists = hasOwn(current, key);
        if (!exists) {
          if (count >= MAX_MAP_ENTRIES) { ok = false; return; }
          count += 1;
        }
        if (kind === 'options') {
          var before = exists && isPlainObject(current[key]) ? current[key] : {};
          OPTION_FIELDS.forEach(function (f) {
            if (hasOwn(value, f) && value[f] !== before[f]) ops.push({ path: [field, key, f], value: value[f] });
            else if (!hasOwn(value, f) && hasOwn(before, f)) ops.push({ path: [field, key, f], del: true });
          });
        } else if (!exists || current[key] !== value) {
          ops.push({ path: [field, key], value: value });
        }
      });
      ops.forEach(function (op) { if (!enqueue(op)) ok = false; });
      return ok;
    }

    // ---------------- public API ----------------

    // Returns true when the scope actually changed (callers re-render).
    function setScope(next) {
      var value = typeof next === 'string' ? next : 'pending';
      if (value === scopeKey) return false;
      scopeKey = value;
      memory = {};
      if (cloudDoc) {
        stopCloud();
        var uid = accountUid(scopeKey);
        if (uid) startCloud(uid);
      }
      return true;
    }

    function getString(name) {
      if (session && hasOwn(spec, name)) {
        var target = spec[name];
        if (target[0] === 'view') {
          var value = session.merged.view[target[1]];
          return typeof value === 'string' ? value : null;
        }
        return JSON.stringify(cloudGetMap(name));
      }
      var key = keyFor(name);
      if (!key || !storage || session) return hasOwn(memory, name) ? memory[name] : null;
      return readStorage(key);
    }

    function setString(name, value) {
      var text = String(value);
      if (session && hasOwn(spec, name)) {
        var target = spec[name];
        if (target[0] !== 'view') return false;
        text = text.slice(0, VIEW_FIELDS[target[1]]);
        if (session.merged.view[target[1]] === text) return true;
        return enqueue({ path: ['view', target[1]], value: text });
      }
      var key = keyFor(name);
      if (!key || !storage || session) {
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
      if (session && hasOwn(spec, name)) return cloudGetMap(name);
      var raw = getString(name);
      if (raw === null) return {};
      try {
        var parsed = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    // Account maps are capped (oldest entries dropped first; callers delete and
    // re-add a key when updating it so it counts as recent). Guest maps keep
    // their original, uncapped behaviour. Cloud maps only send the entries
    // that actually changed, and refuse new entries beyond the cap.
    function setMap(name, map) {
      if (session && hasOwn(spec, name)) return cloudSetMap(name, map);
      var next = isPlainObject(map) ? map : {};
      if (accountUid(scopeKey)) {
        var keys = Object.keys(next);
        var trimmed = {};
        keys.slice(Math.max(0, keys.length - MAX_MAP_ENTRIES)).forEach(function (k) { trimmed[k] = next[k]; });
        next = trimmed;
      }
      var text;
      try { text = JSON.stringify(next); } catch (e) { return false; }
      if (accountUid(scopeKey)) {
        // Drop the oldest entries until the map fits the size cap.
        var entries = Object.keys(next);
        while (text.length > MAX_STRING_LENGTH && entries.length) {
          delete next[entries.shift()];
          text = JSON.stringify(next);
        }
      }
      return setString(name, text);
    }

    // Drops entries for products that no longer exist (account scope only).
    // Never prunes against an empty product list (e.g. the CSV failed).
    function pruneMap(name, validKeys) {
      if (!accountUid(scopeKey)) return false;
      var valid = new Set(Array.from(validKeys || [], String));
      if (session && hasOwn(spec, name)) {
        if (!valid.size || spec[name][0] !== 'map') return false;
        var field = spec[name][1];
        var removed = false;
        Object.keys(session.merged[field] || {}).forEach(function (k) {
          if (!valid.has(k)) removed = enqueue({ path: [field, k], del: true }) || removed;
        });
        return removed;
      }
      var map = getMap(name);
      var changed = false;
      Object.keys(map).forEach(function (k) {
        if (!valid.has(k)) { delete map[k]; changed = true; }
      });
      return changed ? setMap(name, map) : false;
    }

    // Loads the Firestore backend lazily (only once an account is signed in).
    function attachCloud(loader) {
      if (!cloudDoc || typeof loader !== 'function') return;
      cloudLoader = loader;
      if (session && !backendPromise && !backend) ensureBackend(session);
    }

    function onRemoteChange(listener) {
      remoteListeners.push(listener);
      return function () { remoteListeners = remoteListeners.filter(function (l) { return l !== listener; }); };
    }

    function onSyncChange(listener) {
      syncListeners.push(listener);
      try { listener(Object.assign({}, syncState)); } catch (e) { /* ignore */ }
      return function () { syncListeners = syncListeners.filter(function (l) { return l !== listener; }); };
    }

    if (cloudDoc && typeof opts.onOnline === 'function') {
      opts.onOnline(function () { if (session) retrySync(); });
    } else if (cloudDoc && typeof global.addEventListener === 'function') {
      global.addEventListener('online', function () { if (session) retrySync(); });
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
      pruneMap: pruneMap,
      attachCloud: attachCloud,
      onRemoteChange: onRemoteChange,
      onSyncChange: onSyncChange,
      getSyncState: function () { return Object.assign({}, syncState); },
      retrySync: retrySync
    };
  }

  // ---------------- reading position helpers ----------------

  // cards: [{ key, top, height }] in page order, `top` relative to the
  // viewport. The anchor is the first card crossing the top edge.
  function captureAnchor(cards, scrollY, maxScroll) {
    var ratio = maxScroll > 0 ? unit(scrollY / maxScroll) : 0;
    var anchor = '';
    var offset = 0;
    for (var i = 0; i < cards.length; i += 1) {
      var card = cards[i];
      if (!card || !(card.height > 0) || card.top + card.height <= 0) continue;
      // A card that starts below the top edge (page header, row gap) isn't a
      // reliable anchor; the page ratio is used instead.
      if (card.top <= 0 && isValidEntryKey(card.key)) {
        anchor = card.key;
        offset = unit(-card.top / card.height) || 0;
      }
      break;
    }
    return { anchor: anchor, offset: offset, ratio: ratio === null ? 0 : ratio };
  }

  // Where to scroll for a saved position. `card` is the anchor's current
  // { top, height } (viewport-relative) or null when it isn't shown.
  function anchorTarget(saved, card, scrollY, maxScroll) {
    var max = Math.max(0, maxScroll || 0);
    var clean = cleanScroll(saved);
    if (!clean) return null;
    var target = clean.anchor && card && card.height > 0
      ? scrollY + card.top + clean.offset * card.height
      : clean.ratio * max;
    return Math.round(Math.min(max, Math.max(0, target)));
  }

  // Remembers the reading position of a product/gallery list and restores it
  // on page entry only. Any user interaction (wheel, touch, key, mouse)
  // stops automatic restores so remote changes never move the page while
  // someone is browsing or typing.
  function trackReadingPosition(options) {
    var win = options.win || global;
    var prefs = options.prefs;
    var name = options.name;
    var setT = options.setTimeout || function (fn, ms) { return win.setTimeout(fn, ms); };
    var clearT = options.clearTimeout || function (id) { win.clearTimeout(id); };
    var saveDelay = typeof options.saveDelay === 'number' ? options.saveDelay : 1000;
    var interacted = false;
    var entryOpen = true;
    var restorePending = false;
    var saveTimer = null;
    var settleTimer = null;

    function markInteracted() {
      interacted = true;
      if (settleTimer) { clearT(settleTimer); settleTimer = null; }
    }

    function measure() {
      return options.cards().map(function (card) {
        var rect = card.element.getBoundingClientRect();
        return { key: card.key, top: rect.top, height: rect.height };
      });
    }

    function maxScroll() {
      var doc = win.document && win.document.documentElement;
      return Math.max(0, (doc ? doc.scrollHeight : 0) - (win.innerHeight || 0));
    }

    function save() {
      saveTimer = null;
      if (!prefs.isAccount()) return;
      var cards = measure();
      if (!cards.length) return;
      prefs.setMap(name, captureAnchor(cards, win.scrollY || 0, maxScroll()));
    }

    function restoreNow() {
      if (interacted) return false;
      var saved = prefs.getMap(name);
      if (!saved || typeof saved.ratio !== 'number') return false;
      var card = null;
      if (saved.anchor) {
        var match = options.cards().filter(function (c) { return c.key === saved.anchor; })[0];
        if (match) {
          var rect = match.element.getBoundingClientRect();
          card = { top: rect.top, height: rect.height };
        }
      }
      var target = anchorTarget(saved, card, win.scrollY || 0, maxScroll());
      if (target === null) return false;
      if (Math.abs(target - (win.scrollY || 0)) >= 1) win.scrollTo(0, target);
      return true;
    }

    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
      win.addEventListener(type, markInteracted, { passive: true, capture: true });
    });
    win.addEventListener('scroll', function () {
      if (!interacted) return; // our own restores and browser restores aren't saved
      if (saveTimer) clearT(saveTimer);
      saveTimer = setT(save, saveDelay);
    }, { passive: true });

    return {
      isInteracted: function () { return interacted; },
      markInteracted: markInteracted,
      // True while saved view/scroll may still be applied (page entry).
      canApplyEntry: function () { return entryOpen && !interacted; },
      closeEntry: function () { entryOpen = false; },
      // New scope (sign-in change): drop timers so nothing from the
      // previous scope is saved into the new one, and allow one restore.
      resetScope: function () {
        if (saveTimer) { clearT(saveTimer); saveTimer = null; }
        if (settleTimer) { clearT(settleTimer); settleTimer = null; }
        entryOpen = true;
        restorePending = true;
      },
      requestRestore: function () { restorePending = true; },
      // Call after rendering the list. Restores once, then once more after
      // images have had time to load and change the layout.
      afterRender: function () {
        if (!restorePending) return;
        restorePending = false;
        if (!restoreNow()) return;
        if (settleTimer) clearT(settleTimer);
        settleTimer = setT(function () { settleTimer = null; restoreNow(); }, 700);
      }
    };
  }

  // Shows the account sync status in `element` ([data-sync-text] + Retry
  // button). Hidden for guests.
  function bindSyncStatus(prefs, element) {
    if (!element || !prefs || typeof prefs.onSyncChange !== 'function') return;
    var text = element.querySelector('[data-sync-text]');
    var button = element.querySelector('button');
    if (button) button.addEventListener('click', function () { prefs.retrySync(); });
    prefs.onSyncChange(function (state) {
      element.hidden = state.mode !== 'cloud';
      element.setAttribute('data-status', state.status);
      if (text) text.textContent = state.message;
      if (button) button.hidden = !state.canRetry;
    });
  }

  global.JGV3DPrefs = {
    PREFIX: PREFIX,
    CACHE_PREFIX: CACHE_PREFIX,
    MAX_MAP_ENTRIES: MAX_MAP_ENTRIES,
    MAX_CHANGED_PER_WRITE: MAX_CHANGED_PER_WRITE,
    SCHEMA_VERSION: SCHEMA_VERSION,
    LIMITS: LIMITS,
    accountUid: accountUid,
    accountKey: accountKey,
    cacheKey: cacheKey,
    sanitizeState: sanitizeState,
    captureAnchor: captureAnchor,
    anchorTarget: anchorTarget,
    createScopedPrefs: createScopedPrefs,
    trackReadingPosition: trackReadingPosition,
    bindSyncStatus: bindSyncStatus
  };
})(typeof window !== 'undefined' ? window : globalThis);
