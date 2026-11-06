import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { createApp } from '../src/core/app.js';
import { createUser, createToken } from '../src/core/auth.js';
import { allocate, simplifyDebts } from '../src/modules/expenses/split.js';

process.env.TZ = 'Europe/Madrid';
let base, server, tAna, tLuis, ana, luis, eva;

before(async () => {
  const db = await openDb('memory://');
  const app = await createApp(db);
  ana = await createUser(db, { name: 'Ana', isAdmin: true });
  luis = await createUser(db, { name: 'Luis' });
  tAna = await createToken(db, ana);
  tLuis = await createToken(db, luis);
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body, t = tAna) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};
const net = (b, id) => b.users.find((u) => u.id === id).net;
const sharesOf = (e) => Object.fromEntries(e.shares.map((s) => [s.userId, s.cents]));
const cleanup = async () => {
  for (const e of (await call('GET', '/api/expenses')).body) await call('DELETE', `/api/expenses/${e.id}`);
  for (const s of (await call('GET', '/api/expenses/settlements')).body) await call('DELETE', `/api/expenses/settlements/${s.id}`);
  await call('PUT', '/api/expenses/split-settings', { mode: 'equal' });
};

test('allocate: céntimos sobrantes deterministas', () => {
  assert.deepEqual(allocate(1000, [{ userId: 3, weight: 1 }, { userId: 1, weight: 1 }, { userId: 2, weight: 1 }]),
    [{ userId: 1, cents: 334 }, { userId: 2, cents: 333 }, { userId: 3, cents: 333 }]);
  assert.deepEqual(allocate(1001, [{ userId: 1, weight: 1 }, { userId: 2, weight: 1 }, { userId: 3, weight: 1 }]).map((x) => x.cents), [334, 334, 333]);
  // 60/40 con importe impar: el céntimo va al mayor resto
  assert.deepEqual(allocate(999, [{ userId: 1, weight: 60 }, { userId: 2, weight: 40 }]).map((x) => x.cents), [599, 400]);
  // pesos con decimales y suma siempre exacta
  for (const total of [1, 7, 100, 12345, 99999]) {
    const r = allocate(total, [{ userId: 1, weight: 33.33 }, { userId: 2, weight: 33.33 }, { userId: 3, weight: 33.34 }]);
    assert.equal(r.reduce((s, x) => s + x.cents, 0), total);
  }
  assert.deepEqual(allocate(500, [{ userId: 1, weight: 0 }, { userId: 2, weight: 2 }]), [{ userId: 2, cents: 500 }]);
});

test('simplifyDebts: lista mínima', () => {
  const d = simplifyDebts([{ id: 1, name: 'A', net: 3000 }, { id: 2, name: 'B', net: -1000 }, { id: 3, name: 'C', net: -2000 }]);
  assert.deepEqual(d.map((x) => [x.from, x.to, x.amount_cents]), [[3, 1, 2000], [2, 1, 1000]]);
  assert.deepEqual(simplifyDebts([{ id: 1, name: 'A', net: 0 }]), []);
});

test('reparto igual entre dos y saldo neto', async () => {
  const e = await call('POST', '/api/expenses', { amount: '30', description: 'Compra', paidBy: ana, date: '2026-11-01' });
  assert.equal(e.status, 201);
  assert.equal(e.body.shared, 1);
  assert.deepEqual(sharesOf(e.body), { [ana]: 1500, [luis]: 1500 });
  const b = (await call('GET', '/api/expenses/balances')).body;
  assert.equal(net(b, ana), 1500);
  assert.equal(net(b, luis), -1500);
  assert.deepEqual(b.debts, [{ from: luis, fromName: 'Luis', to: ana, toName: 'Ana', amount_cents: 1500 }]);
  const q = await call('GET', '/api/quick/balance?format=text', null, tLuis);
  assert.match(q.body, /^Luis debe 15,00\s€ a Ana.$/);
  await cleanup();
});

test('gasto personal no cuenta en el balance', async () => {
  const p = await call('POST', '/api/expenses', { amount: '50', description: 'Zapatos', paidBy: luis, shared: false });
  assert.equal(p.body.shared, 0);
  assert.deepEqual(sharesOf(p.body), { [luis]: 5000 });
  const w = await call('POST', '/api/quick/expense', { amount: '9,99', merchant: 'Farmacia', personal: true }, tLuis);
  assert.equal(w.body.expense.shared, 0);
  assert.match(w.body.message, /^Gasto personal de 9,99/);
  const s = await call('GET', '/api/quick/expense?text=5%20cafe&shared=false', null, tAna);
  assert.equal(s.body.expense.shared, 0);
  const b = (await call('GET', '/api/expenses/balances')).body;
  assert.equal(b.totalShared, 0);
  assert.deepEqual(b.debts, []);
  assert.equal((await call('GET', '/api/quick/balance?format=text')).body, 'Estáis en paz: nadie debe nada.');
  // de personal a compartido con PATCH
  const e = await call('PATCH', `/api/expenses/${p.body.id}`, { shared: true });
  assert.deepEqual(sharesOf(e.body), { [ana]: 2500, [luis]: 2500 });
  await cleanup();
});

test('proporción por defecto con pesos 60/40', async () => {
  const st = await call('PUT', '/api/expenses/split-settings', { mode: 'weights', weights: { [ana]: 60, [luis]: 40 } });
  assert.equal(st.status, 200);
  assert.deepEqual(st.body.weights.map((w) => w.percent), [60, 40]);
  const e = await call('POST', '/api/expenses', { amount: '10,01', description: 'Luz', paidBy: luis });
  assert.deepEqual(sharesOf(e.body), { [ana]: 601, [luis]: 400 });
  const b = (await call('GET', '/api/expenses/balances')).body;
  assert.deepEqual(b.debts.map((d) => [d.from, d.to, d.amount_cents]), [[ana, luis, 601]]);
  assert.equal((await call('PUT', '/api/expenses/split-settings', { mode: 'weights', weights: { [ana]: 0 } })).status, 400);
  await cleanup();
});

test('reparto personalizado por importes y por pesos', async () => {
  const bad = await call('POST', '/api/expenses', { amount: '20', description: 'Cena', splits: [{ userId: ana, amount: '5' }, { userId: luis, amount: '10' }] });
  assert.equal(bad.status, 400);
  assert.equal((await call('POST', '/api/expenses', { amount: '20', description: 'X', splits: [{ userId: ana, amount: '5' }, { userId: luis, weight: 1 }] })).status, 400);
  const e = await call('POST', '/api/expenses', { amount: '20', description: 'Cena', paidBy: ana, splits: [{ userId: ana, amount: '5' }, { userId: luis, amount: '15' }] });
  assert.equal(e.status, 201);
  assert.deepEqual(sharesOf(e.body), { [ana]: 500, [luis]: 1500 });
  assert.equal(e.body.splits.length, 2);
  // cambiar el importe sin ajustar el reparto por importes no cuadra → 400 y no se guarda
  assert.equal((await call('PATCH', `/api/expenses/${e.body.id}`, { amount: '25' })).status, 400);
  assert.equal((await call('GET', `/api/expenses/${e.body.id}`)).body.amount_cents, 2000);
  // pesos 1:3
  const w = await call('PATCH', `/api/expenses/${e.body.id}`, { amount: '25', splits: [{ userId: ana, weight: 1 }, { userId: luis, weight: 3 }] });
  assert.deepEqual(sharesOf(w.body), { [ana]: 625, [luis]: 1875 });
  // quitar reparto personalizado vuelve a la proporción por defecto (iguales)
  const d = await call('PATCH', `/api/expenses/${e.body.id}`, { splits: null });
  assert.deepEqual(sharesOf(d.body), { [ana]: 1250, [luis]: 1250 });
  assert.equal(d.body.splits.length, 0);
  await cleanup();
});

test('tres miembros: liquidaciones, simplificación y redondeo', async () => {
  const r = await call('POST', '/api/users', { name: 'Eva' });
  eva = r.body.user.id;
  // Ana paga 100 € entre los tres: 33,34 / 33,33 / 33,33
  const e1 = await call('POST', '/api/expenses', { amount: '100', description: 'Súper', paidBy: ana, date: '2026-10-05' });
  assert.deepEqual(sharesOf(e1.body), { [ana]: 3334, [luis]: 3333, [eva]: 3333 });
  // Luis paga 30 € solo entre Luis y Eva
  await call('POST', '/api/expenses', { amount: '30', description: 'Cine', paidBy: luis, date: '2026-11-02', splits: [{ userId: luis, weight: 1 }, { userId: eva, weight: 1 }] });
  let b = (await call('GET', '/api/expenses/balances')).body;
  assert.equal(net(b, ana), 6666);
  assert.equal(net(b, luis), -3333 + 1500);
  assert.equal(net(b, eva), -3333 - 1500);
  assert.equal(b.users.reduce((s, u) => s + u.net, 0), 0);
  assert.deepEqual(b.debts.map((d) => [d.from, d.to, d.amount_cents]), [[eva, ana, 4833], [luis, ana, 1833]]);
  // rango de fechas: solo noviembre
  const nov = (await call('GET', '/api/expenses/balances?from=2026-11-01&to=2026-11-30')).body;
  assert.deepEqual(nov.debts.map((d) => [d.from, d.to, d.amount_cents]), [[eva, luis, 1500]]);
  // liquidación: Eva paga a Ana lo que le debe
  const bad = await call('POST', '/api/expenses/settlements', { to: ana, amount: '10' });
  assert.equal(bad.status, 400); // Ana no puede pagarse a sí misma
  const s = await call('POST', '/api/expenses/settlements', { from: 'Eva', to: ana, amount: '48,33', date: '2026-11-03', notes: 'Bizum' });
  assert.equal(s.status, 201);
  assert.equal(s.body.from_name, 'Eva');
  assert.equal(s.body.amount_cents, 4833);
  b = (await call('GET', '/api/expenses/balances')).body;
  assert.equal(net(b, eva), 0);
  assert.deepEqual(b.debts.map((d) => [d.from, d.to, d.amount_cents]), [[luis, ana, 1833]]);
  // Luis salda desde su token (from por defecto = quien llama)
  const s2 = await call('POST', '/api/expenses/settlements', { to: ana, amount: 18.33 }, tLuis);
  assert.equal(s2.body.from_user, luis);
  assert.equal((await call('GET', '/api/quick/balance?format=text')).body, 'Estáis en paz: nadie debe nada.');
  const list = (await call('GET', '/api/expenses/settlements')).body;
  assert.equal(list.length, 2);
  const upd = await call('PATCH', `/api/expenses/settlements/${s2.body.id}`, { amount: '10' });
  assert.equal(upd.body.amount_cents, 1000);
  assert.equal((await call('DELETE', `/api/expenses/settlements/${s2.body.id}`)).status, 200);
  b = (await call('GET', '/api/expenses/balances')).body;
  assert.deepEqual(b.debts.map((d) => [d.from, d.to, d.amount_cents]), [[luis, ana, 1833]]);
  // el resumen mensual incluye lo que le corresponde a cada uno
  const sum = (await call('GET', '/api/expenses/summary?month=2026-11')).body;
  const byId = Object.fromEntries(sum.byUser.map((u) => [u.id, u]));
  assert.equal(byId[luis].total, 3000);
  assert.equal(byId[luis].share, 1500);
  assert.equal(byId[eva].share, 1500);
  assert.equal(byId[ana].share, 0);
  await cleanup();
});
