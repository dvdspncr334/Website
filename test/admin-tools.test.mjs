import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTime, activityStats, filterActivity, exportTableCSV,
  backupData, backupFilename, createSessionAudit
} from '../admin-tools.js';

const now = new Date('2026-10-03T12:00:00Z').getTime();
const day = 86400000;
const users = [
  { uid: 'a', email: 'Zed@example.com', lastSignInAt: new Date(now - day), lastActiveAt: new Date(now) },
  { uid: 'b', email: 'amy@example.com', lastSignInAt: { toDate: () => new Date(now - 7 * day) }, lastActiveAt: new Date(now - day) },
  { uid: 'c', email: 'other@example.com', lastSignInAt: new Date(now - 8 * day) },
  { uid: 'd', email: 'future@example.com', lastSignInAt: new Date(now + day) },
  { uid: 'e', email: 'missing@example.com' }
];

test('dashboard stats count all records and use last-sign-in windows including boundaries', () => {
  assert.deepEqual(activityStats(users, now), { totalUsers: 5, activeUsers: 1, recentSignIns: 2 });
  assert.equal(activityTime('invalid'), null);
  assert.equal(activityTime(null), null);
  assert.equal(activityTime(0), 0);
});

test('activity filters combine email and inclusive local date range, sort without mutation', () => {
  const data = [
    { uid: '1', email: 'Amy@example.com', lastSignInAt: new Date('2026-10-01T00:00:00') },
    { uid: '2', email: 'amy2@example.com', lastSignInAt: new Date('2026-10-02T23:59:59.999') },
    { uid: '3', email: 'amy3@example.com', lastSignInAt: new Date('2026-10-03T00:00:00') },
    { uid: '4', email: 'other@example.com', lastSignInAt: new Date('2026-10-01T12:00:00') },
    { uid: '5', email: 'amy4@example.com' }
  ];
  assert.deepEqual(filterActivity(data, { email: ' AMY ', start: '2026-10-01', end: '2026-10-02', sort: 'lastSignInAt' }).map(u => u.uid), ['2', '1']);
  assert.deepEqual(filterActivity(data, { start: '2026-10-03', end: '2026-10-01' }), []);
  assert.equal(filterActivity(data, { sort: 'email', direction: 'asc' })[0].uid, '1');
  assert.equal(filterActivity(data, { sort: 'lastSignInAt', direction: 'asc' })[0].uid, '5');
  assert.deepEqual(data.map(u => u.uid), ['1', '2', '3', '4', '5']);
  assert.equal(filterActivity(data).length, 5);
});

test('CSV exports quote commas, quotes and newlines and neutralize spreadsheet formulas', () => {
  const csv = exportTableCSV(['email', 'details'], [['a,b', 'He said "hi"\nagain'], ['=1+1', '\t@SUM(A1)'], ['  +1', null]]);
  assert.equal(csv, '"email","details"\r\n"a,b","He said ""hi""\nagain"\r\n"\'=1+1","\'\t@SUM(A1)"\r\n"\'  +1",""\r\n');
});

test('backups contain CSV products and only whitelisted activity/admin metadata', () => {
  const products = [{ id: 'product', price: '20' }];
  const backup = backupData(products, [{ ...users[0], password: 'excluded', token: 'excluded' }], [
    { uid: 'admin', email: 'admin@example.com', addedAt: new Date(now), addedBy: 'root', token: 'excluded' }
  ], new Date(now));
  assert.equal(backup.timestamp, new Date(now).toISOString());
  assert.deepEqual(backup.products, products);
  assert.notEqual(backup.products[0], products[0]);
  assert.equal(backup.users[0].lastSignInAt, new Date(now - day).toISOString());
  assert.doesNotMatch(JSON.stringify(backup), /excluded|password|token/);
  assert.deepEqual(JSON.parse(JSON.stringify(backup)), backup);
  assert.equal(backupFilename(new Date(2026, 9, 3, 4, 5, 6)), 'jgv3d-backup-2026-10-03-040506.json');
});

test('audit stores session-only entries, resets on refresh, clears, and tolerates unavailable storage', () => {
  const map = new Map([['unrelated', 'keep']]);
  const storage = { setItem: (key, value) => map.set(key, value) };
  const audit = createSessionAudit(storage);
  audit.record('Bulk update', 'product: price=20', 1);
  assert.equal(JSON.parse(map.get('jgv3d_admin_audit'))[0].count, 1);
  const entries = audit.entries();
  entries[0].details = 'changed';
  assert.equal(audit.entries()[0].details, 'product: price=20');
  assert.equal(createSessionAudit(storage).entries().length, 0);
  assert.equal(map.get('unrelated'), 'keep');
  audit.clear();
  assert.deepEqual(audit.entries(), []);
  const blocked = createSessionAudit({ setItem: () => { throw new Error('blocked'); } });
  blocked.record('Backup', 'Downloaded', 3);
  assert.equal(blocked.entries().length, 1);
});
