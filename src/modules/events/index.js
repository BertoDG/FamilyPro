import { bad, intId, notFound } from '../../core/http.js';
import { expandOccurrences } from '../../lib/recurrence.js';
import { isDate, isDateTime, toUTC, fmtDateTime, today } from '../../lib/dates.js';
import { parseSpanishDate } from '../../lib/nlp-date.js';

const RECURRENCES = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const rowToEvent = (e) => e && ({
  ...e, all_day: !!e.all_day, assignees: parseJSON(e.assignees, []), exdates: parseJSON(e.exdates, []),
});

/** Normaliza fechas llegadas desde la web o desde Atajos ("2026-11-06T17:00:00+01:00" → "2026-11-06T17:00"). */
function normStart(v, allDay) {
  if (!v) return null;
  const s = String(v).trim();
  if (allDay) return isDate(s.slice(0, 10)) ? s.slice(0, 10) : null;
  if (isDateTime(s.slice(0, 16))) return s.slice(0, 16);
  if (isDate(s)) return `${s}T09:00`;
  return null;
}

function validate(db, b, existing = {}) {
  const e = { ...existing, ...b };
  const allDay = !!(b.allDay ?? b.all_day ?? existing.all_day);
  const title = String(e.title ?? '').trim();
  if (!title) throw bad('Falta el título');
  const start = normStart(e.start, allDay);
  if (!start) throw bad('Fecha de inicio no válida');
  let end = normStart(e.end, allDay);
  if (!end) end = allDay ? start : fmtDateTime(new Date(toUTC(start).getTime() + 3600e3));
  if (end < start) throw bad('La fecha de fin es anterior al inicio');
  const recurrence = RECURRENCES.includes(e.recurrence) ? e.recurrence : 'none';
  const calendarId = e.calendarId ?? e.calendar_id ?? db.prepare('SELECT id FROM event_calendars ORDER BY position, id LIMIT 1').get()?.id;
  return {
    title, description: String(e.description ?? ''), location: String(e.location ?? ''), start, end, all_day: allDay ? 1 : 0,
    calendar_id: calendarId ?? null, color: e.color || null, recurrence,
    recurrence_interval: Math.max(1, Number(e.recurrenceInterval ?? e.recurrence_interval) || 1),
    recurrence_until: (e.recurrenceUntil ?? e.recurrence_until) && isDate(String(e.recurrenceUntil ?? e.recurrence_until).slice(0, 10))
      ? String(e.recurrenceUntil ?? e.recurrence_until).slice(0, 10) : null,
    assignees: JSON.stringify(Array.isArray(e.assignees) ? e.assignees.map(Number).filter(Boolean) : []),
    exdates: JSON.stringify(Array.isArray(e.exdates) ? e.exdates : []),
  };
}

const COLS = ['title', 'description', 'location', 'start', 'end', 'all_day', 'calendar_id', 'color', 'recurrence', 'recurrence_interval', 'recurrence_until', 'assignees', 'exdates'];

function insertEvent(db, v, userId) {
  const r = db.prepare(`INSERT INTO events (${COLS.map((c) => `"${c}"`).join(',')}, created_by) VALUES (${COLS.map(() => '?').join(',')}, ?)`)
    .run(...COLS.map((c) => v[c]), userId ?? null);
  return getEvent(db, Number(r.lastInsertRowid));
}

const getEvent = (db, id) => rowToEvent(db.prepare(`SELECT e.*, c.name AS calendar_name, COALESCE(e.color, c.color) AS display_color
  FROM events e LEFT JOIN event_calendars c ON c.id = e.calendar_id WHERE e.id = ?`).get(id));

function occurrences(db, from, to) {
  const rows = db.prepare(`SELECT e.*, c.name AS calendar_name, c.color AS calendar_color FROM events e
    LEFT JOIN event_calendars c ON c.id = e.calendar_id
    WHERE substr(e.start,1,10) <= ? AND (e.recurrence != 'none' OR substr(e."end",1,10) >= ?)
      AND (e.recurrence_until IS NULL OR e.recurrence_until >= ?)`).all(to, from, from).map(rowToEvent);
  const users = new Map(db.prepare('SELECT id, name, color FROM users').all().map((u) => [u.id, u]));
  return rows.flatMap((e) => expandOccurrences(e, from, to).map((o) => ({
    id: `event-${e.id}-${o.start.slice(0, 10)}`, eventId: e.id, title: e.title, start: o.start, end: o.end, allDay: e.all_day,
    color: e.color || e.calendar_color, location: e.location, description: e.description, recurring: e.recurrence !== 'none',
    group: e.calendar_id ? { id: e.calendar_id, label: e.calendar_name, color: e.calendar_color } : null,
    assignees: e.assignees.map((id) => users.get(id)).filter(Boolean),
  })));
}

export default {
  id: 'events',
  name: 'Calendario',
  icon: '📅',
  migrations: [
    `CREATE TABLE event_calendars (
       id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#4f7cff', position INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
       start TEXT NOT NULL, "end" TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0,
       calendar_id INTEGER REFERENCES event_calendars(id) ON DELETE SET NULL, color TEXT,
       recurrence TEXT NOT NULL DEFAULT 'none', recurrence_interval INTEGER NOT NULL DEFAULT 1, recurrence_until TEXT,
       assignees TEXT NOT NULL DEFAULT '[]', exdates TEXT NOT NULL DEFAULT '[]',
       created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
     CREATE INDEX idx_events_start ON events(start);
     INSERT INTO event_calendars (name, color, position) VALUES
       ('Familia', '#4f7cff', 0), ('Colegio', '#22a06b', 1), ('Médicos', '#ef4444', 2), ('Cumpleaños', '#ec4899', 3), ('Trabajo', '#64748b', 4);`,
  ],

  routes(r, { db }) {
    r.get('/calendars', (req, res) => res.json(db.prepare('SELECT * FROM event_calendars ORDER BY position, id').all()));
    r.post('/calendars', (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Falta el nombre');
      const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM event_calendars').get().p;
      const id = Number(db.prepare('INSERT INTO event_calendars (name, color, position) VALUES (?, ?, ?)').run(name, req.body?.color || '#4f7cff', pos).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM event_calendars WHERE id = ?').get(id));
    });
    r.patch('/calendars/:id', (req, res) => {
      const id = intId(req.params.id);
      if (req.body?.name) db.prepare('UPDATE event_calendars SET name = ? WHERE id = ?').run(String(req.body.name), id);
      if (req.body?.color) db.prepare('UPDATE event_calendars SET color = ? WHERE id = ?').run(String(req.body.color), id);
      res.json(db.prepare('SELECT * FROM event_calendars WHERE id = ?').get(id));
    });
    r.delete('/calendars/:id', (req, res) => {
      db.prepare('DELETE FROM event_calendars WHERE id = ?').run(intId(req.params.id));
      res.json({ ok: true });
    });

    r.get('/', (req, res) => {
      const from = req.query.from || today();
      const to = req.query.to || from;
      if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
      res.json(occurrences(db, from, to));
    });
    r.post('/', (req, res) => res.status(201).json(insertEvent(db, validate(db, req.body || {}), req.user.id)));
    r.get('/:id', (req, res) => {
      const e = getEvent(db, intId(req.params.id));
      if (!e) throw notFound();
      res.json(e);
    });
    r.put('/:id', (req, res) => {
      const id = intId(req.params.id);
      const cur = getEvent(db, id);
      if (!cur) throw notFound();
      const v = validate(db, req.body || {}, cur);
      db.prepare(`UPDATE events SET ${COLS.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(...COLS.map((c) => v[c]), id);
      res.json(getEvent(db, id));
    });
    /** Excluye una ocurrencia concreta de un evento recurrente ("eliminar solo este"). */
    r.post('/:id/exclude', (req, res) => {
      const id = intId(req.params.id);
      const cur = getEvent(db, id);
      if (!cur) throw notFound();
      const date = String(req.body?.date || '').slice(0, 10);
      if (!isDate(date)) throw bad('Fecha no válida');
      const ex = [...new Set([...cur.exdates, date])];
      db.prepare('UPDATE events SET exdates = ? WHERE id = ?').run(JSON.stringify(ex), id);
      res.json(getEvent(db, id));
    });
    r.delete('/:id', (req, res) => {
      db.prepare('DELETE FROM events WHERE id = ?').run(intId(req.params.id));
      res.json({ ok: true });
    });
  },

  quick: {
    event: {
      description: 'Crea un evento. Admite texto libre ("mañana a las 17:30 dentista") o campos separados.',
      params: {
        text: 'Texto libre con fecha y hora', title: '(opcional) título', date: '(opcional) YYYY-MM-DD o fecha ISO de Atajos',
        time: '(opcional) HH:MM', duration: '(opcional) minutos, por defecto 60', calendar: '(opcional) nombre del calendario', allDay: '(opcional) true/false',
      },
      handler({ db }, p, user) {
        let title = p.title, date = p.date ? String(p.date).slice(0, 10) : null;
        let time = p.time || (p.date && isDateTime(String(p.date).slice(0, 16)) ? String(p.date).slice(11, 16) : null);
        if (p.text) {
          const parsed = parseSpanishDate(p.text);
          title = title || parsed.title;
          date = date || parsed.date;
          time = time || parsed.time;
        }
        if (!title) throw bad('Falta el título del evento');
        date = date && isDate(date) ? date : today();
        const allDay = p.allDay === true || p.allDay === 'true' || !time;
        const cal = p.calendar ? db.prepare('SELECT id FROM event_calendars WHERE lower(name) = lower(?)').get(String(p.calendar)) : null;
        const start = allDay ? date : `${date}T${time}`;
        const end = allDay ? date : fmtDateTime(new Date(toUTC(start).getTime() + (Number(p.duration) || 60) * 60e3));
        const ev = insertEvent(db, validate(db, { title, start, end, allDay, calendarId: cal?.id, assignees: [user.id] }), user.id);
        const when = new Date(`${date}T12:00:00Z`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
        return { message: `Evento "${ev.title}" creado para el ${when}${allDay ? '' : ` a las ${time}`}.`, event: ev };
      },
    },
    agenda: {
      description: 'Devuelve la agenda de hoy (o de la fecha indicada) para que Siri la lea.',
      params: { date: '(opcional) YYYY-MM-DD' },
      handler({ db }, p) {
        const date = p.date && isDate(String(p.date).slice(0, 10)) ? String(p.date).slice(0, 10) : today();
        const occ = occurrences(db, date, date);
        if (!occ.length) return { message: 'No hay nada en la agenda.', items: [] };
        const parts = occ.map((o) => (o.allDay ? o.title : `${o.start.slice(11, 16)} ${o.title}`));
        return { message: `Tienes ${occ.length}: ${parts.join('; ')}.`, items: occ };
      },
    },
  },

  calendar: {
    label: 'Eventos',
    color: '#4f7cff',
    fetch: ({ db }, { from, to }) => occurrences(db, from, to).map((o) => ({ ...o, href: `#/events?edit=${o.eventId}&date=${o.start.slice(0, 10)}` })),
    ics: ({ db }) => db.prepare('SELECT * FROM events').all().map(rowToEvent).map((e) => ({
      uid: `event-${e.id}@familypro`, title: e.title, description: e.description, location: e.location, start: e.start, end: e.end,
      allDay: e.all_day, recurrence: e.recurrence, recurrenceInterval: e.recurrence_interval, recurrenceUntil: e.recurrence_until, exdates: e.exdates,
    })),
  },

  summary({ db }) {
    const n = occurrences(db, today(), today()).length;
    return { title: 'Hoy', value: `${n}`, subtitle: n === 1 ? 'evento' : 'eventos', href: '#/events' };
  },
};
