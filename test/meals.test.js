import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { createApp } from '../src/core/app.js';
import { createUser, createToken } from '../src/core/auth.js';
import { today, toUTC, addDays, fmtDate } from '../src/lib/dates.js';

process.env.TZ = 'Europe/Madrid';
let base, token, server, userId;
const T = today();
const TOMORROW = fmtDate(addDays(toUTC(T), 1));

before(async () => {
  const db = await openDb('memory://');
  const app = await createApp(db);
  userId = await createUser(db, { name: 'Ana', isAdmin: true });
  token = await createToken(db, userId);
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

let lasagna, lentils;

test('recipes CRUD', async () => {
  assert.equal((await call('POST', '/api/meals/recipes', { name: ' ' })).status, 400);
  const r = await call('POST', '/api/meals/recipes', {
    name: 'Lasaña', servings: 4, tags: 'pasta, Horno', url: 'https://example.com/lasana',
    ingredients: ['2 cebollas', '500 g de carne picada', 'Placas de lasaña', { name: 'tomate frito', quantity: '400 g' }],
  });
  assert.equal(r.status, 201);
  lasagna = r.body;
  assert.deepEqual(lasagna.tags, ['pasta', 'horno']);
  assert.deepEqual(lasagna.ingredients, [
    { name: 'Cebollas', quantity: '2' }, { name: 'Carne picada', quantity: '500 g' },
    { name: 'Placas de lasaña', quantity: '' }, { name: 'Tomate frito', quantity: '400 g' },
  ]);
  lentils = (await call('POST', '/api/meals/recipes', { name: 'Lentejas', ingredients: '1 kg lentejas\n2 cebollas\nchorizo' })).body;
  assert.equal(lentils.ingredients.length, 3);

  const upd = await call('PUT', `/api/meals/recipes/${lasagna.id}`, { notes: 'Gratinar 10 min' });
  assert.equal(upd.body.notes, 'Gratinar 10 min');
  assert.equal(upd.body.ingredients.length, 4, 'sin "ingredients" no se tocan');
  const search = await call('GET', '/api/meals/recipes?q=horno');
  assert.deepEqual(search.body.map((x) => x.name), ['Lasaña']);
  assert.equal((await call('GET', `/api/meals/recipes/${lasagna.id}`)).body.servings, 4);

  const tmp = (await call('POST', '/api/meals/recipes', { name: 'Temporal' })).body;
  await call('PUT', `/api/meals/plan/${T}/merienda`, { recipeId: tmp.id });
  assert.equal((await call('DELETE', `/api/meals/recipes/${tmp.id}`)).status, 200);
  assert.equal((await call('GET', `/api/meals/recipes/${tmp.id}`)).status, 404);
  // lo planificado conserva el nombre
  assert.equal((await call('GET', `/api/meals/plan/${T}/merienda`)).body.title, 'Temporal');
  await call('DELETE', `/api/meals/plan/${T}/merienda`);
});

test('plan slots', async () => {
  assert.equal((await call('PUT', `/api/meals/plan/${T}/brunch`, { text: 'x' })).status, 400);
  assert.equal((await call('PUT', `/api/meals/plan/${T}/cena`, {})).status, 400);
  const a = await call('PUT', `/api/meals/plan/${T}/comida`, { recipeId: lentils.id, cookId: userId });
  assert.equal(a.body.title, 'Lentejas');
  assert.equal(a.body.cook_name, 'Ana');
  await call('PUT', `/api/meals/plan/${T}/cena`, { text: 'Tortilla' });
  await call('PUT', `/api/meals/plan/${T}/cena`, { recipeId: lasagna.id, notes: 'sobras' }); // reemplaza
  await call('PUT', `/api/meals/plan/${TOMORROW}/cena`, { text: 'Pizza' });
  const plan = await call('GET', `/api/meals/plan?from=${T}&to=${TOMORROW}`);
  assert.deepEqual(plan.body.map((p) => `${p.date}/${p.meal}/${p.title}`), [`${T}/comida/Lentejas`, `${T}/cena/Lasaña`, `${TOMORROW}/cena/Pizza`]);
  assert.equal(plan.body[1].notes, 'sobras');
});

test('export ingredients to shopping without duplicates', async () => {
  const r = await call('POST', '/api/meals/plan/shopping', { from: T, to: TOMORROW });
  assert.equal(r.status, 200);
  assert.equal(r.body.recipes, 2);
  // "Cebollas" aparece en las dos recetas pero se añade una vez
  assert.deepEqual(r.body.added.sort(), ['400 g Tomate frito', '1 kg Lentejas', '2 Cebollas', '500 g Carne picada', 'Chorizo', 'Placas de lasaña'].sort());
  assert.deepEqual(r.body.skipped, ['Cebollas']);
  const again = await call('POST', '/api/meals/plan/shopping', { from: T, to: TOMORROW });
  assert.equal(again.body.added.length, 0);
  assert.equal(again.body.skipped.length, 7);
  const lists = await call('GET', '/api/shopping/lists');
  const items = await call('GET', `/api/shopping/lists/${lists.body[0].id}/items`);
  assert.equal(items.body.length, 6);
  const none = await call('POST', '/api/meals/plan/shopping', { from: '2020-01-01', to: '2020-01-07' });
  assert.match(none.body.message, /No hay recetas/);
});

test('copy week', async () => {
  const to = fmtDate(addDays(toUTC(T), 7));
  const r = await call('POST', '/api/meals/plan/copy', { from: T, to });
  assert.equal(r.body.copied, 3);
  const plan = await call('GET', `/api/meals/plan?from=${to}&to=${fmtDate(addDays(toUTC(to), 6))}`);
  assert.deepEqual(plan.body.map((p) => p.title), ['Lentejas', 'Lasaña', 'Pizza']);
  assert.equal((await call('POST', '/api/meals/plan/copy', { from: T, to })).body.skipped, 3);
});

test('quick meal + meal-plan', async () => {
  const q = await call('GET', '/api/quick/meal?format=text');
  assert.equal(q.body, 'Hoy para comer hay Lentejas (cocina Ana) y para cenar Lasaña.');
  const m = await call('GET', `/api/quick/meal?text=${encodeURIComponent('mañana')}`);
  assert.equal(m.body.message, 'Mañana para cenar hay Pizza.');
  const only = await call('GET', `/api/quick/meal?date=${T}&meal=cena`);
  assert.equal(only.body.message, 'Hoy para cenar hay Lasaña.');
  assert.match((await call('GET', '/api/quick/meal?date=2020-01-01')).body.message, /No hay nada planificado/);

  const p = await call('POST', '/api/quick/meal-plan', { text: 'mañana para comer macarrones' });
  assert.equal(p.status, 200);
  assert.equal(p.body.message, 'Mañana para comer: Macarrones.');
  assert.equal(p.body.slot.date, TOMORROW);
  const p2 = await call('POST', '/api/quick/meal-plan', { date: T, meal: 'merienda', text: 'lasaña' });
  assert.equal(p2.body.slot.recipe_id, lasagna.id, 'enlaza la receta por nombre');
  assert.equal((await call('POST', '/api/quick/meal-plan', { text: '' })).status, 400);
  await call('DELETE', `/api/meals/plan/${T}/merienda`);
});

test('calendar source + summary', async () => {
  const mods = await call('GET', '/api/modules');
  const meals = mods.body.find((m) => m.id === 'meals');
  assert.equal(meals.calendar.defaultVisible, false);
  const cal = await call('GET', `/api/calendar?from=${T}&to=${T}&sources=meals`);
  assert.deepEqual(cal.body.map((x) => x.title).sort(), ['🍽️ Cena: Lasaña', '🍽️ Comida: Lentejas']);
  assert.ok(cal.body.every((x) => x.allDay && x.source === 'meals' && x.href.startsWith('#/meals')));
  const dash = await call('GET', '/api/dashboard');
  const s = dash.body.find((x) => x.module === 'meals');
  assert.ok(['Lentejas', 'Lasaña'].includes(s.value));
  // el ICS no se rompe con una fuente sin ics
  assert.equal((await call('GET', '/api/calendar.ics')).status, 200);
});
