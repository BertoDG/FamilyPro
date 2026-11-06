import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.js';
import { createApp } from '../src/core/app.js';
import { createUser, createToken } from '../src/core/auth.js';
import { today, toUTC, addDays, fmtDate } from '../src/lib/dates.js';
import { nextDue, nextAssignee } from '../src/modules/tasks/index.js';

process.env.TZ = 'Europe/Madrid';
let base, token, token2, ana, luis, server;

before(async () => {
  const db = await openDb('memory://');
  const app = await createApp(db);
  ana = await createUser(db, { name: 'Ana', isAdmin: true });
  luis = await createUser(db, { name: 'Luis' });
  token = await createToken(db, ana);
  token2 = await createToken(db, luis);
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
const plus = (n) => fmtDate(addDays(toUTC(today()), n));

test('helpers de recurrencia y rotación', () => {
  assert.equal(nextDue('2026-11-02', 'weekly', 1, '2026-11-03'), '2026-11-09');
  assert.equal(nextDue('2026-11-02', 'daily', 2, '2026-11-02'), '2026-11-04');
  assert.equal(nextDue('2026-01-31', 'monthly', 1, '2026-01-31'), '2026-02-28');
  assert.equal(nextDue(null, 'daily', 1, '2026-11-06'), '2026-11-07');
  assert.equal(nextAssignee([1, 2, 3], 3), 1);
  assert.equal(nextAssignee([1, 2], 9), 1);
  assert.equal(nextAssignee([], 5), 5);
});

test('crear, editar, filtrar y borrar tareas', async () => {
  const c = await call('POST', '/api/tasks', { title: 'Regar las plantas', dueDate: plus(0), priority: 'high', assigneeId: luis });
  assert.equal(c.status, 201);
  assert.equal(c.body.title, 'Regar las plantas');
  assert.equal(c.body.assignee_name, 'Luis');
  assert.equal(c.body.done, false);
  assert.equal((await call('POST', '/api/tasks', { title: '' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'X', dueDate: 'mañana' })).status, 400);

  const e = await call('PATCH', `/api/tasks/${c.body.id}`, { dueTime: '19:30', notes: 'Las del balcón' });
  assert.equal(e.body.due_time, '19:30');
  assert.equal(e.body.notes, 'Las del balcón');

  const mineLuis = await call('GET', '/api/tasks?mine=1', null, token2);
  assert.ok(mineLuis.body.some((t) => t.id === c.body.id));
  const mineAna = await call('GET', '/api/tasks?mine=1');
  assert.ok(!mineAna.body.some((t) => t.id === c.body.id));

  const done = await call('POST', `/api/tasks/${c.body.id}/complete`, null, token2);
  assert.equal(done.body.done, true);
  assert.equal(done.body.completed_by_name, 'Luis');
  assert.ok(!(await call('GET', '/api/tasks')).body.some((t) => t.id === c.body.id));
  assert.ok((await call('GET', '/api/tasks?status=done')).body.some((t) => t.id === c.body.id));
  const undo = await call('POST', `/api/tasks/${c.body.id}/uncomplete`);
  assert.equal(undo.body.done, false);
  assert.equal(undo.body.completed_at, null);

  assert.equal((await call('DELETE', `/api/tasks/${c.body.id}`)).status, 200);
  assert.equal((await call('GET', `/api/tasks/${c.body.id}`)).status, 404);
});

test('quick task con fecha en el texto y responsable', async () => {
  const r = await call('POST', '/api/quick/task', { text: 'mañana a las 18:00 sacar la basura', assignee: 'luis' });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.title, 'Sacar la basura');
  assert.equal(r.body.task.due_date, plus(1));
  assert.equal(r.body.task.due_time, '18:00');
  assert.equal(r.body.task.assignee_name, 'Luis');
  assert.match(r.body.message, /^Tarea "Sacar la basura" añadida para el .+ a las 18:00 \(Luis\)\.$/);

  const p = await call('POST', '/api/quick/task?format=text', { text: 'llamar al fontanero para Ana' });
  assert.equal(p.body, 'Tarea "Llamar al fontanero" añadida (Ana).');
  assert.equal((await call('POST', '/api/quick/task', { text: '  ' })).status, 400);
  assert.equal((await call('POST', '/api/quick/task', { text: 'algo', assignee: 'Nadie' })).status, 400);

  const list = await call('GET', '/api/quick/tasks-list?format=text', null, token2);
  assert.match(list.body, /^Tienes 1 tarea pendiente: Sacar la basura \(mañana a las 18:00\)\.$/);
  const all = await call('GET', '/api/quick/tasks-list?all=true');
  assert.match(all.body.message, /^Hay 2 tareas pendientes: /);
});

test('completar recurrente avanza la fecha y rota el responsable', async () => {
  const c = await call('POST', '/api/tasks', {
    title: 'Fregar los platos', dueDate: '2026-01-05', recurrence: 'weekly', recurrenceInterval: 1, rotation: [ana, luis], assigneeId: ana,
  });
  assert.equal(c.status, 201);
  assert.deepEqual(c.body.rotation, [ana, luis]);
  assert.equal(c.body.recurring, true);

  const d1 = await call('POST', `/api/tasks/${c.body.id}/complete`);
  assert.equal(d1.body.done, false, 'una recurrente sigue pendiente');
  assert.equal(d1.body.assignee_id, luis);
  assert.equal(toUTC(d1.body.due_date).getUTCDay(), 1, 'sigue cayendo en lunes');
  assert.ok(d1.body.due_date > today() && d1.body.due_date <= plus(7));
  assert.equal(d1.body.completed_by_name, 'Ana');

  const d2 = await call('POST', `/api/tasks/${c.body.id}/complete`, null, token2);
  assert.equal(d2.body.assignee_id, ana);
  assert.equal(d2.body.due_date, fmtDate(addDays(toUTC(d1.body.due_date), 7)));
  assert.equal((await call('GET', `/api/tasks/${c.body.id}/history`)).body.length, 2);

  // descompletar deshace la última vez
  const u = await call('POST', `/api/tasks/${c.body.id}/uncomplete`);
  assert.equal(u.body.due_date, d1.body.due_date);
  assert.equal(u.body.assignee_id, luis);

  // si el responsable no está en la rotación se usa el primero
  const fix = await call('PATCH', `/api/tasks/${c.body.id}`, { rotation: [luis], assigneeId: ana });
  assert.equal(fix.body.assignee_id, luis);
  await call('DELETE', `/api/tasks/${c.body.id}`);
});

test('fuente de calendario, ICS y resumen', async () => {
  const a = await call('POST', '/api/tasks', { title: 'Pagar el seguro', dueDate: plus(-2) });
  const b = await call('POST', '/api/tasks', { title: 'Cita ITV', dueDate: plus(3), dueTime: '09:15', recurrence: 'monthly' });
  const z = await call('POST', '/api/tasks', { title: 'Sin fecha' });
  const hecho = await call('POST', '/api/tasks', { title: 'Ya hecha', dueDate: plus(1) });
  await call('POST', `/api/tasks/${hecho.body.id}/complete`);

  const cal = await call('GET', `/api/calendar?from=${plus(-5)}&to=${plus(10)}&sources=tasks`);
  assert.equal(cal.status, 200);
  const ids = cal.body.map((x) => x.taskId);
  assert.ok(ids.includes(a.body.id) && ids.includes(b.body.id));
  assert.ok(!ids.includes(z.body.id) && !ids.includes(hecho.body.id));
  const itv = cal.body.find((x) => x.taskId === b.body.id);
  assert.equal(itv.allDay, false);
  assert.equal(itv.start, `${plus(3)}T09:15`);
  assert.equal(itv.end, `${plus(3)}T09:45`);
  assert.equal(itv.source, 'tasks');
  assert.equal(itv.sourceLabel, 'Tareas');
  assert.match(itv.href, /^#\/tasks/);
  const seguro = cal.body.find((x) => x.taskId === a.body.id);
  assert.equal(seguro.allDay, true);
  assert.equal(seguro.start, plus(-2));

  const mods = await call('GET', '/api/modules');
  assert.ok(mods.body.find((m) => m.id === 'tasks').calendar);

  const ics = await call('GET', '/api/calendar.ics?sources=tasks');
  assert.match(ics.body, /UID:task-\d+@familypro/);
  assert.match(ics.body, /SUMMARY:☐ Cita ITV/);
  assert.match(ics.body, /RRULE:FREQ=MONTHLY/);

  const dash = await call('GET', '/api/dashboard');
  const s = dash.body.find((x) => x.module === 'tasks');
  assert.equal(s.href, '#/tasks');
  assert.ok(Number(s.value) >= 1);
  assert.match(s.subtitle, /atrasada/);
});
