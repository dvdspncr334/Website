// Firestore security rules tests. Run with the emulator:
//   npm install && npm run test:rules
// (needs Java 11+; `firebase emulators:exec` sets FIRESTORE_EMULATOR_HOST).
// Without an emulator these tests are skipped.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemKey, planMutation, addOperation, removeOperation, changeQtyOperation } from '../cart-store.js';
import { createFirestoreCartBackend } from '../cart-firebase.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulator ? false : 'FIRESTORE_EMULATOR_HOST not set (run `npm run test:rules`)';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let env;
let rut;
let fs;

before(async () => {
  if (!emulator) return;
  rut = await import('@firebase/rules-unit-testing');
  fs = await import('firebase/firestore');
  const [host, port] = emulator.split(':');
  env = await rut.initializeTestEnvironment({
    projectId: 'demo-jgv3d',
    firestore: { rules: readFileSync(path.join(root, 'firestore.rules'), 'utf8'), host, port: Number(port) }
  });
});

after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => { if (env) await env.clearFirestore(); });

const item = (id, qty = 1) => ({ id, title: id, price: 199.99, img: 'images/a.png', qty });
const cartPath = uid => `users/${uid}/carts/current`;
const db = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

async function validCart(id = 'strat') {
  const key = await itemKey(id);
  return { key, data: { items: { [key]: item(id) }, lastKey: key, schema: 1, updatedAt: fs.serverTimestamp() } };
}

async function seed(uid, id = 'strat') {
  const { data } = await validCart(id);
  await env.withSecurityRulesDisabled(ctx => fs.setDoc(fs.doc(ctx.firestore(), cartPath(uid)), { ...data, updatedAt: new Date() }));
}

function backendFor(uid) {
  return createFirestoreCartBackend({ db: db(uid), auth: { currentUser: { uid } }, onUserChanged: () => () => {}, fs });
}

test('owner can create, read, update and delete their own cart', { skip }, async () => {
  const { assertSucceeds } = rut;
  const { data, key } = await validCart();
  const ref = fs.doc(db('alice'), cartPath('alice'));
  await assertSucceeds(fs.setDoc(ref, data));
  await assertSucceeds(fs.getDoc(ref));
  await assertSucceeds(fs.setDoc(ref, { ...data, items: { [key]: { ...item('strat'), qty: 5 } } }));
  await assertSucceeds(fs.deleteDoc(ref));
});

test('unauthenticated users and other accounts cannot read or write a cart', { skip }, async () => {
  const { assertFails } = rut;
  await seed('alice');
  const { data } = await validCart('evil');
  for (const reader of [null, 'bob']) {
    const ref = fs.doc(db(reader), cartPath('alice'));
    await assertFails(fs.getDoc(ref));
    await assertFails(fs.setDoc(ref, data));
    await assertFails(fs.deleteDoc(ref));
  }
  await assertFails(fs.getDocs(fs.collection(db('bob'), 'users/alice/carts')));
  await assertFails(fs.getDoc(fs.doc(db('alice'), 'users/alice')), 'parent users doc is not opened');
  await assertFails(fs.getDoc(fs.doc(db('alice'), 'users/alice/carts/other')));
});

test('schema, sizes and quantities are validated', { skip }, async () => {
  const { assertFails } = rut;
  const { data, key } = await validCart();
  const ref = fs.doc(db('alice'), cartPath('alice'));
  const bad = [
    { ...data, items: { [key]: { ...item('strat'), qty: 0 } } },
    { ...data, items: { [key]: { ...item('strat'), qty: 100 } } },
    { ...data, items: { [key]: { ...item('strat'), qty: 1.5 } } },
    { ...data, items: { [key]: { ...item('strat'), price: -1 } } },
    { ...data, items: { [key]: { ...item('strat'), title: 'x'.repeat(301) } } },
    { ...data, items: { [key]: { ...item('strat'), img: 'javascript:alert(1)' } } },
    { ...data, items: { [key]: { ...item('strat'), extra: true } } },
    { ...data, lastKey: 'not-a-key' },
    { ...data, updatedAt: new Date(0) },
    { ...data, schema: 2 },
    { ...data, owner: 'bob' }
  ];
  for (const doc of bad) await assertFails(fs.setDoc(ref, doc));
  const tooMany = {};
  for (let i = 0; i < 51; i += 1) tooMany[await itemKey(`i${i}`)] = item(`i${i}`);
  await assertFails(fs.setDoc(ref, { ...data, items: tooMany }));
});

test('a single write may change only the line named by lastKey', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  await seed('alice', 'strat');
  const ref = fs.doc(db('alice'), cartPath('alice'));
  const strat = await itemKey('strat');
  const tele = await itemKey('tele');
  const jazz = await itemKey('jazz');
  await assertFails(fs.setDoc(ref, {
    items: { [strat]: item('strat'), [tele]: item('tele'), [jazz]: item('jazz') },
    lastKey: tele, schema: 1, updatedAt: fs.serverTimestamp()
  }));
  await assertSucceeds(fs.setDoc(ref, {
    items: { [strat]: item('strat'), [tele]: item('tele') }, lastKey: tele, schema: 1, updatedAt: fs.serverTimestamp()
  }));
  await assertSucceeds(fs.setDoc(ref, { items: {}, lastKey: strat, schema: 1, updatedAt: fs.serverTimestamp() }));
});

test('the real client backend writes pass the rules (add, change, remove)', { skip }, async () => {
  const { assertSucceeds, assertFails } = rut;
  const alice = backendFor('alice');
  const plan = op => raw => planMutation(raw, op);
  await assertSucceeds(alice.mutateCart('alice', plan(addOperation(item('strat (Right, HSS, Custom Color: teal)', 2))), () => true));
  await assertSucceeds(alice.mutateCart('alice', plan(addOperation(item('tele', 1))), () => true));
  await assertSucceeds(alice.mutateCart('alice', plan(changeQtyOperation('tele', 3)), () => true));
  await assertSucceeds(alice.mutateCart('alice', plan(removeOperation(['tele', 'strat (Right, HSS, Custom Color: teal)'])), () => true));
  // A backend whose signed-in user is bob cannot write alice's cart.
  const bobAsAlice = createFirestoreCartBackend({ db: db('bob'), auth: { currentUser: { uid: 'bob' } }, onUserChanged: () => () => {}, fs });
  await assertFails(bobAsAlice.mutateCart('alice', plan(addOperation(item('x'))), () => true));
});

/* ---------------- Admins and user activity ---------------- */

const asUser = (uid, email = `${uid}@example.com`) => env.authenticatedContext(uid, { email }).firestore();

async function seedDoc(docPath, data) {
  await env.withSecurityRulesDisabled(ctx => fs.setDoc(fs.doc(ctx.firestore(), docPath), data));
}

// Bootstrap: the first admin is written in the Firebase Console, which
// bypasses rules (simulated here with rules disabled).
async function seedAdmin(uid) {
  await seedDoc(`admins/${uid}`, { note: 'added in console' });
}

async function seedActivity(uid, email = `${uid}@example.com`) {
  await seedDoc(`userActivity/${uid}`, { email, lastSignInAt: new Date(), lastActiveAt: new Date() });
}

const adminDoc = (by, email) => ({ email, addedBy: by, addedAt: fs.serverTimestamp() });
const activityDoc = (email, extra = {}) => ({
  email, lastSignInAt: fs.Timestamp.fromMillis(Date.now() - 60000), lastActiveAt: fs.serverTimestamp(), ...extra
});

test('unauthenticated users cannot read or write admins or userActivity', { skip }, async () => {
  const { assertFails } = rut;
  await seedAdmin('root');
  await seedActivity('bob');
  const anon = db(null);
  await assertFails(fs.getDoc(fs.doc(anon, 'admins/root')));
  await assertFails(fs.getDocs(fs.collection(anon, 'admins')));
  await assertFails(fs.setDoc(fs.doc(anon, 'admins/bob'), adminDoc('bob', 'bob@example.com')));
  await assertFails(fs.deleteDoc(fs.doc(anon, 'admins/root')));
  await assertFails(fs.getDocs(fs.collection(anon, 'userActivity')));
  await assertFails(fs.setDoc(fs.doc(anon, 'userActivity/bob'), activityDoc('bob@example.com')));
});

test('non-admins can only check their own admin status', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  await seedAdmin('root');
  await seedActivity('bob');
  const bob = asUser('bob');
  await assertSucceeds(fs.getDoc(fs.doc(bob, 'admins/bob')), 'reading own (missing) admin doc is allowed');
  await assertFails(fs.getDoc(fs.doc(bob, 'admins/root')));
  await assertFails(fs.getDocs(fs.collection(bob, 'admins')));
  await assertFails(fs.setDoc(fs.doc(bob, 'admins/bob'), adminDoc('bob', 'bob@example.com')), 'no self-promotion');
  await assertFails(fs.deleteDoc(fs.doc(bob, 'admins/root')));
  await assertFails(fs.getDoc(fs.doc(bob, 'userActivity/bob')));
  await assertFails(fs.getDocs(fs.collection(bob, 'userActivity')));
});

test('first admin bootstrap: no client can create an admin until one is added in the console', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  await seedActivity('alice');
  await seedActivity('bob');
  await assertFails(fs.setDoc(fs.doc(asUser('alice'), 'admins/alice'), adminDoc('alice', 'alice@example.com')));
  await seedAdmin('alice');
  await assertSucceeds(fs.getDoc(fs.doc(asUser('alice'), 'admins/alice')));
  await assertSucceeds(fs.setDoc(fs.doc(asUser('alice'), 'admins/bob'), adminDoc('alice', 'bob@example.com')));
  await assertSucceeds(fs.getDocs(fs.collection(asUser('bob'), 'admins')), 'the new admin is an admin');
});

test('admins can list admins, read activity, and add/remove admins with valid data', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  await seedAdmin('root');
  await seedActivity('bob');
  await seedActivity('dave');
  const root = asUser('root');
  await assertSucceeds(fs.getDocs(fs.collection(root, 'admins')));
  await assertSucceeds(fs.getDoc(fs.doc(root, 'admins/bob')));
  await assertSucceeds(fs.getDocs(fs.query(fs.collection(root, 'userActivity'), fs.where('email', 'in', ['bob@example.com']))));
  await assertSucceeds(fs.getDocs(fs.query(fs.collection(root, 'userActivity'), fs.orderBy('lastActiveAt', 'desc'), fs.limit(50))));

  await assertFails(fs.setDoc(fs.doc(root, 'admins/carol'), adminDoc('root', 'carol@example.com')), 'unknown user (no activity record)');
  await assertFails(fs.setDoc(fs.doc(root, 'admins/bob'), adminDoc('root', 'someone@example.com')), 'email must match the user');
  await assertFails(fs.setDoc(fs.doc(root, 'admins/bob'), adminDoc('dave', 'bob@example.com')), 'addedBy must be the requester');
  await assertFails(fs.setDoc(fs.doc(root, 'admins/bob'), { ...adminDoc('root', 'bob@example.com'), role: 'owner' }));
  await assertFails(fs.setDoc(fs.doc(root, 'admins/bob'), { ...adminDoc('root', 'bob@example.com'), addedAt: new Date(0) }));
  await assertSucceeds(fs.setDoc(fs.doc(root, 'admins/bob'), adminDoc('root', 'bob@example.com')));
  await assertFails(fs.setDoc(fs.doc(root, 'admins/bob'), adminDoc('root', 'bob@example.com')), 'admin docs are not updated in place');

  await assertSucceeds(fs.deleteDoc(fs.doc(root, 'admins/bob')));
  await assertSucceeds(fs.deleteDoc(fs.doc(root, 'admins/root')), 'an admin may remove themselves');
  await assertFails(fs.getDocs(fs.collection(root, 'admins')), 'removed admin loses access');
});

test('users may only write their own activity record with their own email', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  const bob = asUser('bob');
  const ref = fs.doc(bob, 'userActivity/bob');
  await assertSucceeds(fs.setDoc(ref, activityDoc('bob@example.com')));
  await assertSucceeds(fs.setDoc(ref, activityDoc('bob@example.com', { lastSignInAt: fs.serverTimestamp() })));
  await assertFails(fs.setDoc(ref, activityDoc('root@example.com')), 'email must match the auth token');
  await assertFails(fs.setDoc(ref, activityDoc('bob@example.com', { lastActiveAt: new Date(0) })));
  await assertFails(fs.setDoc(ref, activityDoc('bob@example.com', { lastSignInAt: fs.Timestamp.fromMillis(Date.now() + 86400000) })));
  await assertFails(fs.setDoc(ref, activityDoc('bob@example.com', { isAdmin: true })));
  await assertFails(fs.setDoc(fs.doc(bob, 'userActivity/alice'), activityDoc('bob@example.com')));
  await assertFails(fs.deleteDoc(ref));
  const noEmail = env.authenticatedContext('eve').firestore();
  await assertFails(fs.setDoc(fs.doc(noEmail, 'userActivity/eve'), activityDoc('')));
});

test('only current admins can delete activity; deletes never touch auth or admin records', { skip }, async () => {
  const { assertFails, assertSucceeds } = rut;
  await seedAdmin('root');
  await seedActivity('bob');
  await seedActivity('alice');
  for (const user of [db(null), asUser('bob'), asUser('alice')]) {
    await assertFails(fs.deleteDoc(fs.doc(user, 'userActivity/bob')));
  }
  const root = asUser('root');
  const batch = fs.writeBatch(root);
  batch.delete(fs.doc(root, 'userActivity/bob'));
  batch.delete(fs.doc(root, 'userActivity/alice'));
  await assertSucceeds(batch.commit());
  assert.equal((await fs.getDocs(fs.collection(root, 'userActivity'))).size, 0);
  assert.equal((await fs.getDoc(fs.doc(root, 'admins/root'))).exists(), true);
  await seedActivity('bob');
  await assertSucceeds(fs.deleteDoc(fs.doc(root, 'admins/root')));
  await assertFails(fs.deleteDoc(fs.doc(root, 'userActivity/bob')), 'revoked admin cannot delete');
});
