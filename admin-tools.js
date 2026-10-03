// Pure dashboard/export helpers; audit data stays in this page session.
export function activityTime(value) {
  if (value == null || value === '') return null;
  const date = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

export function activityStats(users, now = Date.now()) {
  const countSince = duration => users.filter(user => {
    const time = activityTime(user.lastSignInAt);
    return time !== null && time >= now - duration && time <= now;
  }).length;
  return {
    totalUsers: users.length,
    activeUsers: countSince(24 * 60 * 60 * 1000),
    recentSignIns: countSince(7 * 24 * 60 * 60 * 1000)
  };
}

export function filterActivity(users, { email = '', start = '', end = '', sort = 'lastActiveAt', direction = 'desc' } = {}) {
  const first = start ? new Date(`${start}T00:00:00`).getTime() : -Infinity;
  const last = end ? new Date(`${end}T00:00:00`) : null;
  if (last) last.setDate(last.getDate() + 1);
  const afterLast = last ? last.getTime() : Infinity;
  const query = email.trim().toLowerCase();
  return users.filter(user => {
    if (!String(user.email || '').toLowerCase().includes(query)) return false;
    if (!start && !end) return true;
    const time = activityTime(user.lastSignInAt);
    return time !== null && time >= first && time < afterLast;
  }).sort((a, b) => {
    const order = sort === 'email'
      ? String(a.email || '').localeCompare(String(b.email || ''), undefined, { sensitivity: 'base' })
      : (activityTime(a[sort]) ?? -Infinity) - (activityTime(b[sort]) ?? -Infinity);
    return direction === 'asc' ? order : -order;
  });
}

export function exportTableCSV(headers, records) {
  const quote = value => {
    let text = value == null ? '' : String(value);
    // Neutralize spreadsheet formulas, even after leading whitespace.
    if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [headers, ...records].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}

function isoTime(value) {
  const time = activityTime(value);
  return time === null ? null : new Date(time).toISOString();
}

export function backupData(products, users, admins, now = new Date()) {
  return {
    timestamp: now.toISOString(),
    products: products.map(product => ({ ...product })),
    users: users.map(user => ({
      uid: user.uid, email: user.email,
      lastSignInAt: isoTime(user.lastSignInAt), lastActiveAt: isoTime(user.lastActiveAt)
    })),
    admins: admins.map(admin => ({
      uid: admin.uid, email: admin.email, addedBy: admin.addedBy, addedAt: isoTime(admin.addedAt)
    }))
  };
}

export function backupFilename(now = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `jgv3d-backup-${date}-${time}.json`;
}

export function createSessionAudit(storage) {
  const key = 'jgv3d_admin_audit';
  let log = [];
  const save = () => {
    try { if (storage) storage.setItem(key, JSON.stringify(log)); } catch (e) { /* memory-only if storage is blocked */ }
  };
  save(); // A page refresh starts a new audit session.
  return {
    record(action, details, count = 0) {
      const entry = { timestamp: new Date().toISOString(), action: String(action), details: String(details), count };
      log.push(entry);
      save();
      return { ...entry };
    },
    entries: () => log.map(entry => ({ ...entry })),
    clear() { log = []; save(); }
  };
}
