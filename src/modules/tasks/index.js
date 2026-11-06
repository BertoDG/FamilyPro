import { bad, intId, notFound } from '../../core/http.js';
import { transaction, NOW } from '../../core/db.js';
import { isDate, toUTC, addDays, fmtDate, fmtDateTime, today } from '../../lib/dates.js';
import { parseSpanishDate } from '../../lib/nlp-date.js';

/*
 * Tareas del hogar.
 *
 * Diseño de las tareas recurrentes (simple a propósito): una tarea recurrente es UNA sola fila que nunca queda "hecha".
 * Al completarla se guarda un registro en `task_completions` (quién, cuándo, qué fecha tocaba y quién era el responsable)
 * y la propia tarea avanza: su fecha límite salta al siguiente múltiplo del intervalo que caiga después de hoy
 * (p.ej. "cada semana, lunes": si la completas el martes, la siguiente es el lunes que viene) y, si tiene rotación,
 * el responsable pasa al siguiente de la lista. "Descompletar" deshace la última vez usando ese registro.
 * Las tareas normales simplemente se marcan como hechas (done = 1).
 */

const PRIORITIES = ['low', 'normal', 'high'];
const RECURRENCES = ['none', 'daily', 'weekly', 'monthly'];
const PRIORITY_ORDER = "CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const joinEs = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr.at(-1)}`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const SELECT = `SELECT t.*, a.name AS assignee_name, a.color AS assignee_color, c.name AS completed_by_name
  FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users c ON c.id = t.completed_by`;

const rowToTask = (t) => t && ({ ...t, done: !!t.done, rotation: parseJSON(t.rotation, []), recurring: t.recurrence !== 'none' });
const getTask = async (db, id) => rowToTask(await db.get(`${SELECT} WHERE t.id = ?`, id));

/** Suma meses fijando el día al último del mes si no existe (31 → 30 de abril). */
function addMonthsClamped(d, n) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

/** Siguiente fecha límite de una tarea recurrente: avanza desde su fecha hasta pasar `after` (hoy). */
export function nextDue(due, recurrence, interval = 1, after = today()) {
  const step = Math.max(1, Number(interval) || 1);
  const adv = (d) => (recurrence === 'daily' ? addDays(d, step) : recurrence === 'weekly' ? addDays(d, 7 * step) : addMonthsClamped(d, step));
  let d = adv(toUTC(due || after));
  const limit = toUTC(after);
  for (let i = 0; d <= limit && i < 10000; i++) d = adv(d);
  return fmtDate(d);
}

/** Siguiente responsable de la rotación (si el actual no está en ella, empieza por el primero). */
export function nextAssignee(rotation, current) {
  if (!rotation?.length) return current ?? null;
  const i = rotation.indexOf(current);
  return rotation[(i + 1) % rotation.length];
}

/** Busca un usuario por id o nombre (sin acentos ni mayúsculas). Con exact = false acepta también el principio del nombre. */
async function findUser(db, name, exact = false) {
  if (name === undefined || name === null || name === '') return null;
  const users = await db.all('SELECT id, name FROM users');
  if (/^\d+$/.test(String(name))) return users.find((u) => u.id === Number(name)) || null;
  const n = norm(name);
  return users.find((u) => norm(u.name) === n) || (!exact && n.length >= 2 && users.find((u) => norm(u.name).startsWith(n))) || null;
}

async function validate(db, b, existing = {}) {
  const pick = (...keys) => { for (const k of keys) if (b[k] !== undefined) return b[k]; return undefined; };
  const t = { ...existing };
  const title = pick('title');
  if (title !== undefined) t.title = String(title).trim();
  if (!t.title) throw bad('Falta el título');
  const notes = pick('notes');
  if (notes !== undefined) t.notes = String(notes ?? '');
  t.notes ??= '';

  const due = pick('dueDate', 'due_date', 'due');
  if (due !== undefined) {
    const s = due ? String(due).trim() : '';
    if (s && !isDate(s.slice(0, 10))) throw bad('Fecha límite no válida (YYYY-MM-DD)');
    t.due_date = s ? s.slice(0, 10) : null;
    if (/T\d{2}:\d{2}/.test(s)) t.due_time = s.slice(11, 16);
  }
  const time = pick('dueTime', 'due_time', 'time');
  if (time !== undefined) {
    const s = time ? String(time).trim().slice(0, 5) : '';
    if (s && !/^\d{2}:\d{2}$/.test(s)) throw bad('Hora no válida (HH:MM)');
    t.due_time = s || null;
  }
  if (!t.due_date) t.due_time = null;

  const priority = pick('priority');
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) throw bad('Prioridad no válida (low, normal, high)');
    t.priority = priority;
  }
  t.priority ||= 'normal';

  const ids = new Set((await db.all('SELECT id FROM users')).map((u) => u.id));
  const assignee = pick('assigneeId', 'assignee_id');
  if (assignee !== undefined) {
    if (assignee === null || assignee === '') t.assignee_id = null;
    else if (!ids.has(Number(assignee))) throw bad('Responsable no válido');
    else t.assignee_id = Number(assignee);
  }
  t.assignee_id ??= null;

  const rec = pick('recurrence');
  if (rec !== undefined) {
    if (!RECURRENCES.includes(rec || 'none')) throw bad('Repetición no válida (none, daily, weekly, monthly)');
    t.recurrence = rec || 'none';
  }
  t.recurrence ||= 'none';
  const interval = pick('recurrenceInterval', 'recurrence_interval');
  if (interval !== undefined) t.recurrence_interval = Math.max(1, Math.min(365, Number(interval) || 1));
  t.recurrence_interval ||= 1;

  const rotation = pick('rotation');
  if (rotation !== undefined) {
    t.rotation = [...new Set((Array.isArray(rotation) ? rotation : []).map(Number))].filter((id) => ids.has(id));
  }
  t.rotation = Array.isArray(t.rotation) ? t.rotation : parseJSON(t.rotation, []);
  if (t.recurrence === 'none') t.rotation = [];
  // Con rotación, el responsable debe estar en ella
  if (t.rotation.length && !t.rotation.includes(t.assignee_id)) t.assignee_id = t.rotation[0];
  return t;
}

const COLS = ['title', 'notes', 'due_date', 'due_time', 'priority', 'assignee_id', 'recurrence', 'recurrence_interval', 'rotation'];
const colValue = (t, c) => (c === 'rotation' ? JSON.stringify(t.rotation || []) : t[c] ?? null);

async function insertTask(db, t, userId) {
  const id = await db.insert(`INSERT INTO tasks (${COLS.join(',')}, created_by) VALUES (${COLS.map(() => '?').join(',')}, ?)`,
    ...COLS.map((c) => colValue(t, c)), userId ?? null);
  return getTask(db, id);
}

/** Completa una tarea. Las recurrentes avanzan de fecha y rotan responsable; las normales quedan hechas. */
export async function completeTask(db, id, user) {
  const t = await getTask(db, id);
  if (!t) throw notFound('Tarea no encontrada');
  if (t.done) return t;
  return transaction(db, async (tx) => {
    await tx.run('INSERT INTO task_completions (task_id, user_id, due_date, assignee_id) VALUES (?, ?, ?, ?)',
      id, user?.id ?? null, t.due_date, t.assignee_id);
    if (t.recurring) {
      await tx.run(`UPDATE tasks SET due_date = ?, assignee_id = ?, completed_at = ${NOW}, completed_by = ? WHERE id = ?`,
        nextDue(t.due_date, t.recurrence, t.recurrence_interval), nextAssignee(t.rotation, t.assignee_id), user?.id ?? null, id);
    } else {
      await tx.run(`UPDATE tasks SET done = 1, completed_at = ${NOW}, completed_by = ? WHERE id = ?`, user?.id ?? null, id);
    }
    return getTask(tx, id);
  });
}

/** Deshace la última vez que se completó (restaura fecha y responsable en las recurrentes). */
export async function uncompleteTask(db, id) {
  const t = await getTask(db, id);
  if (!t) throw notFound('Tarea no encontrada');
  return transaction(db, async (tx) => {
    const last = await tx.get('SELECT * FROM task_completions WHERE task_id = ? ORDER BY id DESC LIMIT 1', id);
    if (t.recurring) {
      if (!last) throw bad('Esta tarea no se ha completado todavía');
      await tx.run('DELETE FROM task_completions WHERE id = ?', last.id);
      const prev = await tx.get('SELECT * FROM task_completions WHERE task_id = ? ORDER BY id DESC LIMIT 1', id);
      await tx.run('UPDATE tasks SET due_date = ?, assignee_id = ?, completed_at = ?, completed_by = ? WHERE id = ?',
        last.due_date, last.assignee_id, prev?.completed_at ?? null, prev?.user_id ?? null, id);
    } else {
      if (last) await tx.run('DELETE FROM task_completions WHERE id = ?', last.id);
      await tx.run('UPDATE tasks SET done = 0, completed_at = NULL, completed_by = NULL WHERE id = ?', id);
    }
    return getTask(tx, id);
  });
}

/** Lista tareas. status: pending (por defecto) | done | all. assignee: id de usuario o 'none'. doneSince: YYYY-MM-DD. */
async function listTasks(db, { status = 'pending', assignee, doneSince, limit } = {}) {
  const where = [], args = [];
  if (status === 'pending') where.push('t.done = 0');
  else if (status === 'done') where.push('t.done = 1');
  else if (status !== 'all') throw bad('status debe ser pending, done o all');
  if (assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (assignee !== undefined && assignee !== null && assignee !== '') { where.push('t.assignee_id = ?'); args.push(intId(assignee)); }
  if (doneSince) {
    if (!isDate(doneSince)) throw bad('doneSince debe ser YYYY-MM-DD');
    where.push('(t.done = 0 OR t.completed_at >= ?)'); args.push(doneSince);
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.done, CASE WHEN t.done = 1 THEN t.completed_at END DESC NULLS LAST,
      t.due_date IS NULL, t.due_date, t.due_time IS NULL, t.due_time, ${PRIORITY_ORDER}, t.id
    ${limit ? `LIMIT ${Math.max(1, Number(limit) || 100)}` : ''}`;
  return (await db.all(sql, ...args)).map(rowToTask);
}

const whenLabel = (t, d = today()) => {
  if (!t.due_date) return '';
  const time = t.due_time ? ` a las ${t.due_time}` : '';
  if (t.due_date === d) return `hoy${time}`;
  if (t.due_date === fmtDate(addDays(toUTC(d), 1))) return `mañana${time}`;
  if (t.due_date < d) return `atrasada, ${shortDate(t.due_date)}`;
  return `${shortDate(t.due_date)}${time}`;
};

export default {
  id: 'tasks',
  name: 'Tareas',
  icon: '✅',
  migrations: [
    `CREATE TABLE tasks (
       id SERIAL PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
       due_date TEXT, due_time TEXT, priority TEXT NOT NULL DEFAULT 'normal',
       assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
       done INTEGER NOT NULL DEFAULT 0, completed_at TEXT, completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       recurrence TEXT NOT NULL DEFAULT 'none', recurrence_interval INTEGER NOT NULL DEFAULT 1, rotation TEXT NOT NULL DEFAULT '[]',
       created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (${NOW}));
     CREATE INDEX idx_tasks_done_due ON tasks(done, due_date);
     CREATE TABLE task_completions (
       id SERIAL PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
       user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, due_date TEXT,
       assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL, completed_at TEXT NOT NULL DEFAULT (${NOW}));
     CREATE INDEX idx_task_completions_task ON task_completions(task_id);`,
  ],

  routes(r, { db }) {
    r.get('/', async (req, res) => {
      const q = req.query;
      const mine = q.mine === '1' || q.mine === 'true';
      res.json(await listTasks(db, { status: q.status || 'pending', assignee: mine ? req.user.id : q.assignee, doneSince: q.doneSince, limit: q.limit }));
    });
    r.post('/', async (req, res) => res.status(201).json(await insertTask(db, await validate(db, req.body || {}), req.user.id)));
    r.get('/:id', async (req, res) => {
      const t = await getTask(db, intId(req.params.id));
      if (!t) throw notFound();
      res.json(t);
    });
    const update = async (req, res) => {
      const id = intId(req.params.id);
      const cur = await getTask(db, id);
      if (!cur) throw notFound();
      const t = await validate(db, req.body || {}, cur);
      await db.run(`UPDATE tasks SET ${COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...COLS.map((c) => colValue(t, c)), id);
      // done también se puede cambiar con PATCH {done}
      if (req.body?.done !== undefined && !!req.body.done !== cur.done) {
        return res.json(req.body.done ? await completeTask(db, id, req.user) : await uncompleteTask(db, id));
      }
      res.json(await getTask(db, id));
    };
    r.put('/:id', update);
    r.patch('/:id', update);
    r.delete('/:id', async (req, res) => {
      await db.run('DELETE FROM tasks WHERE id = ?', intId(req.params.id));
      res.json({ ok: true });
    });
    r.post('/:id/complete', async (req, res) => res.json(await completeTask(db, intId(req.params.id), req.user)));
    r.post('/:id/uncomplete', async (req, res) => res.json(await uncompleteTask(db, intId(req.params.id))));
    r.get('/:id/history', async (req, res) => res.json(await db.all(`SELECT c.*, u.name AS user_name FROM task_completions c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id DESC LIMIT 50`, intId(req.params.id))));
  },

  quick: {
    task: {
      description: 'Añade una tarea con texto libre ("mañana sacar la basura", "el viernes a las 18:00 llamar al fontanero").',
      params: {
        text: 'Texto libre con la tarea y, opcionalmente, la fecha', assignee: '(opcional) nombre del responsable',
        date: '(opcional) YYYY-MM-DD o fecha ISO de Atajos', time: '(opcional) HH:MM', priority: '(opcional) low, normal, high',
      },
      async handler({ db }, p, user) {
        let text = String(p.text ?? p.title ?? '').trim();
        if (!text) throw bad('Dime qué tarea quieres añadir');
        let who = p.assignee ? await findUser(db, p.assignee) : null;
        if (p.assignee && !who) throw bad(`No conozco a "${p.assignee}"`);
        if (!who) {
          // "… para Luis" asigna la tarea si coincide con un miembro de la casa
          const m = text.match(/\s+para\s+(\S+)\s*$/i);
          const u = m && await findUser(db, m[1], true);
          if (u) { who = u; text = text.slice(0, m.index).trim(); }
        }
        const parsed = parseSpanishDate(text);
        const title = parsed.title || text;
        let date = p.date ? String(p.date).slice(0, 10) : parsed.date;
        if (date && !isDate(date)) date = parsed.date;
        let time = p.time ? String(p.time).slice(0, 5) : parsed.time;
        if (!time && p.date && /T\d{2}:\d{2}/.test(String(p.date))) time = String(p.date).slice(11, 16);
        const priority = PRIORITIES.includes(p.priority) ? p.priority : (/\burgente\b/i.test(text) ? 'high' : 'normal');
        const t = await insertTask(db, await validate(db, {
          title: priority === 'high' ? title.replace(/\s*\burgente\b\s*/i, ' ').trim() || title : title,
          dueDate: date || null, dueTime: date ? time : null, priority, assigneeId: who?.id ?? null,
        }), user.id);
        const when = t.due_date ? ` para el ${longDate(t.due_date)}${t.due_time ? ` a las ${t.due_time}` : ''}` : '';
        return { message: `Tarea "${t.title}" añadida${when}${who ? ` (${who.name})` : ''}.`, task: t };
      },
    },
    'tasks-list': {
      description: 'Lee las tareas pendientes (las tuyas por defecto; all=true para las de toda la casa).',
      params: { all: '(opcional) true para ver las de todos', assignee: '(opcional) nombre de la persona' },
      async handler({ db }, p, user) {
        const all = p.all === true || p.all === 'true' || p.all === '1';
        let who = user;
        if (p.assignee) { who = await findUser(db, p.assignee); if (!who) throw bad(`No conozco a "${p.assignee}"`); }
        const tasks = await listTasks(db, { status: 'pending', assignee: all ? undefined : who.id });
        const d = today();
        const mineLabel = who.id === user.id;
        if (!tasks.length) {
          return { message: all ? 'No hay tareas pendientes en casa. 🎉' : mineLabel ? 'No tienes tareas pendientes.' : `${who.name} no tiene tareas pendientes.`, tasks: [] };
        }
        const parts = tasks.slice(0, 10).map((t) => {
          const extra = [whenLabel(t, d), all && t.assignee_name ? t.assignee_name : ''].filter(Boolean).join(', ');
          return extra ? `${t.title} (${extra})` : t.title;
        });
        const n = tasks.length;
        const head = all ? `Hay ${n} ${n === 1 ? 'tarea pendiente' : 'tareas pendientes'}` : mineLabel ? `Tienes ${n} ${n === 1 ? 'tarea pendiente' : 'tareas pendientes'}` : `${who.name} tiene ${n} ${n === 1 ? 'tarea pendiente' : 'tareas pendientes'}`;
        return { message: `${head}: ${joinEs(parts)}${n > 10 ? ` y ${n - 10} más` : ''}.`, tasks };
      },
    },
  },

  calendar: {
    label: 'Tareas',
    color: '#14b8a6',
    fetch: async ({ db }, { from, to }) => (await db.all(`${SELECT} WHERE t.done = 0 AND t.due_date BETWEEN ? AND ? ORDER BY t.due_date, t.due_time NULLS FIRST, t.id`, from, to))
      .map(rowToTask).map((t) => {
        const start = t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date;
        return {
          id: `task-${t.id}`, taskId: t.id, title: `☐ ${t.title}`, start,
          end: t.due_time ? fmtDateTime(new Date(toUTC(start).getTime() + 30 * 60e3)) : t.due_date,
          allDay: !t.due_time, recurring: t.recurring, priority: t.priority, description: t.notes,
          ...(t.priority === 'high' ? { color: '#ef4444' } : {}),
          assignees: t.assignee_id ? [{ id: t.assignee_id, name: t.assignee_name, color: t.assignee_color }] : [],
          href: `#/tasks?edit=${t.id}`,
        };
      }),
    ics: async ({ db }) => (await db.all(`${SELECT} WHERE t.done = 0 AND t.due_date IS NOT NULL`)).map(rowToTask).map((t) => {
      const start = t.due_time ? `${t.due_date}T${t.due_time}` : t.due_date;
      return {
        uid: `task-${t.id}@familypro`, title: `☐ ${t.title}${t.assignee_name ? ` (${t.assignee_name})` : ''}`, description: t.notes,
        start, end: t.due_time ? fmtDateTime(new Date(toUTC(start).getTime() + 30 * 60e3)) : t.due_date, allDay: !t.due_time,
        recurrence: t.recurrence, recurrenceInterval: t.recurrence_interval,
      };
    }),
  },

  async summary({ db }, user) {
    const d = today();
    const row = await db.get(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE due_date < ?) AS late, COUNT(*) FILTER (WHERE assignee_id = ?) AS mine
      FROM tasks WHERE done = 0 AND due_date <= ?`, d, user?.id ?? 0, d);
    const n = row.n, late = Number(row.late || 0);
    const subtitle = `${n === 1 ? 'pendiente hoy' : 'pendientes hoy'}${late ? ` · ${late} ${late === 1 ? 'atrasada' : 'atrasadas'}` : ''}`;
    return { title: 'Tareas', value: `${n}`, subtitle, href: '#/tasks', overdue: late, mine: Number(row.mine || 0) };
  },
};
