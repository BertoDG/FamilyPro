import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { createApp } from '../src/core/app.js';
import { createUser, createToken } from '../src/core/auth.js';
import { parseAmountToCents, splitItems, parseExpenseText } from '../src/lib/parse.js';
import { expandOccurrences } from '../src/lib/recurrence.js';
import { parseSpanishDate } from '../src/lib/nlp-date.js';

process.env.TZ = 'Europe/Madrid';
let base, token, token2, server;

before(async () => {
  const db = openDb(':memory:');
  const app = createApp(db);
  const admin = createUser(db, { name: 'Ana', isAdmin: true });
  token = createToken(db, admin);
  token2 = createToken(db, createUser(db, { name: 'Luis' }));
  server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body, t = token) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};

test('parsers', () => {
  assert.equal(parseAmountToCents('12,50 €'), 1250);
  assert.equal(parseAmountToCents('€1.234,56'), 123456);
  assert.equal(parseAmountToCents('1,234.56'), 123456);
  assert.equal(parseAmountToCents(7.3), 730);
  assert.equal(parseAmountToCents('abc'), null);
  assert.deepEqual(splitItems('leche, 2 huevos y pan\npapel'), ['leche', '2 huevos', 'pan', 'papel']);
  assert.deepEqual(parseExpenseText('12,50 en Mercadona'), { cents: 1250, text: 'Mercadona' });
  const d = parseSpanishDate('mañana a las 17:30 dentista', '2026-11-06');
  assert.deepEqual(d, { date: '2026-11-07', time: '17:30', title: 'Dentista' });
  assert.equal(parseSpanishDate('el viernes cena con los Pérez', '2026-11-06').date, '2026-11-13');
  assert.equal(parseSpanishDate('15 de diciembre cumple de Ana', '2026-11-06').date, '2026-12-15');
});

test('recurrence', () => {
  const ev = { start: '2026-01-31T10:00', end: '2026-01-31T11:00', recurrence: 'monthly' };
  const occ = expandOccurrences(ev, '2026-01-01', '2026-05-31');
  assert.deepEqual(occ.map((o) => o.start.slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31']);
  const w = expandOccurrences({ start: '2026-11-02', end: '2026-11-02', all_day: true, recurrence: 'weekly', exdates: ['2026-11-09'] }, '2026-11-01', '2026-11-30');
  assert.deepEqual(w.map((o) => o.start), ['2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30']);
});

test('auth required', async () => {
  assert.equal((await call('GET', '/api/me', null, null)).status, 401);
  assert.equal((await call('GET', '/api/me', null, 'fp_bad')).status, 401);
  const me = await call('GET', '/api/me');
  assert.equal(me.body.name, 'Ana');
  // token por query (atajos / ICS)
  const r = await fetch(`${base}/api/me?token=${token2}`);
  assert.equal((await r.json()).name, 'Luis');
  // no admin no puede crear usuarios
  assert.equal((await call('POST', '/api/users', { name: 'X' }, token2)).status, 403);
});

test('quick shopping + list', async () => {
  const r = await call('POST', '/api/quick/shopping', { text: 'leche, 2 huevos y pan' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.added, ['Leche', '2 Huevos', 'Pan']);
  const dup = await call('POST', '/api/quick/shopping', { text: 'Leche' });
  assert.deepEqual(dup.body.skipped, ['Leche']);
  // texto plano como cuerpo y respuesta en texto
  const res = await fetch(`${base}/api/quick/shopping?format=text`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: 'tomates',
  });
  assert.match(await res.text(), /Añadido a Supermercado: Tomates/);
  const list = await call('GET', '/api/quick/shopping-list?format=text');
  assert.match(list.body, /hay 4/);
});

test('quick expense from wallet & siri', async () => {
  const w = await call('POST', '/api/quick/expense', { amount: '23,40 €', merchant: 'MERCADONA', card: 'Visa' });
  assert.equal(w.body.expense.amount_cents, 2340);
  assert.equal(w.body.expense.category_name, 'Supermercado');
  assert.equal(w.body.expense.source, 'wallet');
  const s = await call('GET', '/api/quick/expense?text=' + encodeURIComponent('8,90 gasolina repsol'));
  assert.equal(s.body.expense.amount_cents, 890);
  assert.equal(s.body.expense.category_name, 'Transporte');
  assert.equal((await call('POST', '/api/quick/expense', { text: 'nada' })).status, 400);
  const sum = await call('GET', '/api/expenses/summary');
  assert.equal(sum.body.total, 3230);
});

test('events + main calendar + ics', async () => {
  const e = await call('POST', '/api/events', { title: 'Piscina', start: '2026-11-02T18:00', end: '2026-11-02T19:00', recurrence: 'weekly' });
  assert.equal(e.status, 201);
  await call('POST', `/api/events/${e.body.id}/exclude`, { date: '2026-11-09' });
  const cal = await call('GET', '/api/calendar?from=2026-11-01&to=2026-11-30&sources=events');
  assert.deepEqual(cal.body.map((x) => x.start), ['2026-11-02T18:00', '2026-11-16T18:00', '2026-11-23T18:00', '2026-11-30T18:00']);
  const q = await call('POST', '/api/quick/event', { title: 'Dentista', date: '2026-11-20T10:30:00+01:00' });
  assert.equal(q.body.event.start, '2026-11-20T10:30');
  const ics = await call('GET', '/api/calendar.ics');
  assert.match(ics.body, /RRULE:FREQ=WEEKLY;INTERVAL=1/);
  assert.match(ics.body, /EXDATE;TZID=Europe\/Madrid:20261109T180000/);
});

test('tokens lifecycle', async () => {
  const t = await call('POST', '/api/tokens', { name: 'iPhone' });
  assert.ok(t.body.token.startsWith('fp_'));
  const list = await call('GET', '/api/tokens');
  const id = list.body.find((x) => x.name === 'iPhone').id;
  assert.equal((await call('DELETE', `/api/tokens/${id}`)).status, 200);
  assert.equal((await call('GET', '/api/me', null, t.body.token)).status, 401);
});
