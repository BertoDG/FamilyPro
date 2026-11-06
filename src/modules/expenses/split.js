// Reparto de gastos entre miembros: partes de cada gasto, liquidaciones, balances y simplificación de deudas.
// Todo se calcula en céntimos enteros. Los céntimos sobrantes se reparten por el método del mayor resto
// (a igualdad de resto, primero el id de usuario más bajo), así el resultado es siempre el mismo.
import { bad, intId, notFound } from '../../core/http.js';
import { parseAmountToCents, formatEuros } from '../../lib/parse.js';
import { isDate } from '../../lib/dates.js';

/** Migración: columna shared, partes personalizadas, liquidaciones y ajustes del reparto. */
export function splitMigration(db) {
  db.exec(`ALTER TABLE expenses ADD COLUMN shared INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE expense_splits (
      expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER, weight REAL,
      PRIMARY KEY (expense_id, user_id));
    CREATE TABLE expense_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL, date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX idx_settlements_date ON expense_settlements(date);
    CREATE TABLE expense_split_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
}

// ---------- Utilidades ----------

/** Interpreta booleanos de formularios/atajos: true, "true", "1", "sí", "yes"… Devuelve undefined si no hay valor. */
export function parseBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
}

/** shared (1/0) a partir de `shared` o `personal`; undefined si no viene ninguno. */
export function sharedFromInput(data = {}) {
  const personal = parseBool(data.personal);
  if (personal !== undefined) return personal ? 0 : 1;
  if (typeof data.shared === 'string' && data.shared.trim().toLowerCase() === 'personal') return 0;
  const shared = parseBool(data.shared);
  return shared === undefined ? undefined : (shared ? 1 : 0);
}

/**
 * Reparte `total` céntimos según pesos. entries: [{ userId, weight }]. Devuelve [{ userId, cents }].
 * Mayor resto con desempate por userId: determinista y sin errores de coma flotante.
 */
export function allocate(total, entries) {
  const list = entries
    .map((e) => ({ userId: e.userId, w: BigInt(Math.max(0, Math.round(Number(e.weight) * 10000))) }))
    .filter((e) => e.w > 0n)
    .sort((a, b) => a.userId - b.userId);
  if (!list.length) return [];
  const W = list.reduce((s, e) => s + e.w, 0n);
  const T = BigInt(total);
  const rows = list.map((e) => ({ userId: e.userId, q: (T * e.w) / W, r: (T * e.w) % W }));
  let left = T - rows.reduce((s, x) => s + x.q, 0n);
  [...rows].sort((a, b) => (a.r === b.r ? a.userId - b.userId : (b.r > a.r ? 1 : -1))).forEach((x) => {
    if (left > 0n) { x.q += 1n; left -= 1n; }
  });
  return rows.map((x) => ({ userId: x.userId, cents: Number(x.q) }));
}

// ---------- Ajustes (proporción por defecto) ----------

export function getSettings(db) {
  const row = db.prepare("SELECT value FROM expense_split_settings WHERE key = 'default'").get();
  let s = {};
  try { s = JSON.parse(row?.value || '{}'); } catch { /* ignore */ }
  return { mode: s.mode === 'weights' ? 'weights' : 'equal', weights: s.weights && typeof s.weights === 'object' ? s.weights : {} };
}

/** Participantes por defecto de un gasto compartido sin reparto propio. */
export function defaultEntries(settings, users) {
  if (settings.mode === 'weights') {
    const e = users.map((u) => ({ userId: u.id, weight: Number(settings.weights[u.id]) || 0 })).filter((x) => x.weight > 0);
    if (e.length) return e;
  }
  return users.map((u) => ({ userId: u.id, weight: 1 }));
}

function publicSettings(db) {
  const s = getSettings(db);
  const users = db.prepare('SELECT id, name, color FROM users ORDER BY id').all();
  const entries = defaultEntries(s, users);
  const W = entries.reduce((a, e) => a + e.weight, 0);
  return {
    mode: s.mode,
    weights: users.map((u) => {
      const e = entries.find((x) => x.userId === u.id);
      return { userId: u.id, name: u.name, color: u.color, weight: s.mode === 'weights' ? Number(s.weights[u.id]) || 0 : 1, percent: e ? Math.round((e.weight / W) * 1000) / 10 : 0 };
    }),
  };
}

function saveSettings(db, body = {}) {
  const mode = body.mode === 'weights' ? 'weights' : 'equal';
  const weights = {};
  const src = Array.isArray(body.weights) ? body.weights.map((w) => [w.userId ?? w.id, w.weight ?? w.percent]) : Object.entries(body.weights || {});
  for (const [uid, w] of src) {
    const id = Number(uid), n = Number(String(w ?? '').replace(',', '.'));
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) continue;
    if (!Number.isFinite(n) || n < 0) throw bad('Los pesos deben ser números positivos');
    weights[id] = n;
  }
  if (mode === 'weights' && !Object.values(weights).some((w) => w > 0)) throw bad('Indica al menos un peso mayor que cero');
  db.prepare("INSERT INTO expense_split_settings (key, value) VALUES ('default', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ mode, weights }));
}

// ---------- Partes de cada gasto ----------

/**
 * Normaliza el reparto personalizado recibido por la API.
 * Acepta [{ userId, amount }] (importes), [{ userId, weight }] o [{ userId, percent }] (pesos).
 * Devuelve null si no hay reparto personalizado (usa la proporción por defecto).
 */
export function normalizeSplits(db, splits) {
  if (splits === undefined || splits === null || splits === '' || splits === false) return null;
  if (typeof splits === 'string') { try { splits = JSON.parse(splits); } catch { throw bad('Reparto no válido'); } }
  if (!Array.isArray(splits)) throw bad('splits debe ser una lista');
  if (!splits.length) return null;
  const out = [];
  let kind = null;
  for (const s of splits) {
    const id = Number(s?.userId ?? s?.user_id ?? s?.user ?? s?.id);
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw bad('Miembro del reparto no válido');
    if (out.some((x) => x.user_id === id)) throw bad('Miembro repetido en el reparto');
    let k, amount = null, weight = null;
    if (s.amount !== undefined || s.amount_cents !== undefined || s.cents !== undefined) {
      k = 'amount';
      amount = s.amount !== undefined ? parseAmountToCents(s.amount) : Number(s.amount_cents ?? s.cents);
      if (amount === null || !Number.isInteger(amount) || amount < 0) throw bad('Importe del reparto no válido');
    } else if (s.weight !== undefined || s.percent !== undefined) {
      k = 'weight';
      weight = Number(String(s.weight ?? s.percent).replace(',', '.'));
      if (!Number.isFinite(weight) || weight < 0) throw bad('Peso del reparto no válido');
    } else throw bad('Cada parte necesita amount, weight o percent');
    if (kind && kind !== k) throw bad('No mezcles importes y pesos en el mismo reparto');
    kind = k;
    if ((amount ?? weight) > 0) out.push({ user_id: id, amount_cents: amount, weight });
  }
  if (!out.length) throw bad('El reparto necesita al menos un participante');
  return out;
}

export function saveSplits(db, expenseId, splits) {
  db.prepare('DELETE FROM expense_splits WHERE expense_id = ?').run(expenseId);
  const ins = db.prepare('INSERT INTO expense_splits (expense_id, user_id, amount_cents, weight) VALUES (?, ?, ?, ?)');
  for (const s of splits || []) ins.run(expenseId, s.user_id, s.amount_cents, s.weight);
}

/** Comprueba que un reparto por importes suma exactamente el total del gasto. */
export function checkSplitTotal(db, expenseId) {
  const e = db.prepare('SELECT amount_cents, shared FROM expenses WHERE id = ?').get(expenseId);
  const rows = db.prepare('SELECT amount_cents FROM expense_splits WHERE expense_id = ?').all(expenseId);
  if (!e || !e.shared || !rows.length || rows.some((r) => r.amount_cents === null)) return;
  const sum = rows.reduce((s, r) => s + r.amount_cents, 0);
  if (sum !== e.amount_cents) throw bad(`El reparto suma ${formatEuros(sum)} y el gasto es de ${formatEuros(e.amount_cents)}`);
}

/** Lo que le corresponde a cada uno de un gasto: [{ userId, cents }]. */
export function expenseShares(e, splits, defaults) {
  if (!e.shared) return e.paid_by ? [{ userId: e.paid_by, cents: e.amount_cents }] : [];
  if (splits?.length) {
    const byAmount = splits.every((s) => s.amount_cents !== null && s.amount_cents !== undefined);
    if (byAmount && splits.reduce((a, s) => a + s.amount_cents, 0) === e.amount_cents) {
      return splits.map((s) => ({ userId: s.user_id, cents: s.amount_cents })).sort((a, b) => a.userId - b.userId);
    }
    // Pesos (o importes que ya no cuadran con el total, p.ej. si se borró un miembro): proporcional.
    return allocate(e.amount_cents, splits.map((s) => ({ userId: s.user_id, weight: byAmount ? s.amount_cents : s.weight })));
  }
  return allocate(e.amount_cents, defaults);
}

function splitContext(db) {
  const users = db.prepare('SELECT id, name, color FROM users ORDER BY id').all();
  return { users, defaults: defaultEntries(getSettings(db), users) };
}

function splitsFor(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db.prepare(`SELECT s.*, u.name AS user_name FROM expense_splits s JOIN users u ON u.id = s.user_id
    WHERE s.expense_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.user_id`).all(...ids);
  for (const r of rows) { if (!map.has(r.expense_id)) map.set(r.expense_id, []); map.get(r.expense_id).push(r); }
  return map;
}

/** Añade `splits` (reparto personalizado guardado) y `shares` (parte de cada uno) a filas de gastos. */
export function attachSplits(db, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length || !list[0]) return rows;
  const { defaults } = splitContext(db);
  const map = splitsFor(db, list.map((e) => e.id));
  for (const e of list) {
    const splits = map.get(e.id) || [];
    e.splits = splits.map((s) => ({ userId: s.user_id, name: s.user_name, amount_cents: s.amount_cents, weight: s.weight }));
    e.shares = expenseShares(e, splits, defaults);
  }
  return rows;
}

/** Parte de cada usuario en un rango (compartida + personal) para el resumen mensual. */
export function sharesByUser(db, from, to) {
  const { defaults } = splitContext(db);
  const rows = db.prepare('SELECT id, amount_cents, paid_by, shared FROM expenses WHERE date BETWEEN ? AND ?').all(from, to);
  const map = splitsFor(db, rows.map((e) => e.id));
  const out = new Map();
  const add = (id, k, v) => { if (!out.has(id)) out.set(id, { share: 0, personal: 0 }); out.get(id)[k] += v; };
  for (const e of rows) {
    for (const s of expenseShares(e, map.get(e.id), defaults)) add(s.userId, 'share', s.cents);
    if (!e.shared && e.paid_by) add(e.paid_by, 'personal', e.amount_cents);
  }
  return out;
}

// ---------- Balances ----------

/** Lista mínima de pagos para dejar a todos a cero. nets: [{ id, name, net }]. Determinista. */
export function simplifyDebts(nets) {
  const order = (a, b) => b.amt - a.amt || a.id - b.id;
  const debtors = nets.filter((u) => u.net < 0).map((u) => ({ id: u.id, name: u.name, amt: -u.net })).sort(order);
  const creditors = nets.filter((u) => u.net > 0).map((u) => ({ id: u.id, name: u.name, amt: u.net })).sort(order);
  const out = [];
  while (debtors.length && creditors.length) {
    const d = debtors[0], c = creditors[0];
    const amt = Math.min(d.amt, c.amt);
    out.push({ from: d.id, fromName: d.name, to: c.id, toName: c.name, amount_cents: amt });
    d.amt -= amt; c.amt -= amt;
    if (!d.amt) debtors.shift();
    if (!c.amt) creditors.shift();
    debtors.sort(order); creditors.sort(order);
  }
  return out;
}

export function balances(db, { from, to } = {}) {
  if (from && !isDate(from)) throw bad('from debe ser YYYY-MM-DD');
  if (to && !isDate(to)) throw bad('to debe ser YYYY-MM-DD');
  const { users, defaults } = splitContext(db);
  const where = [], args = [];
  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }
  const w = where.length ? `AND ${where.join(' AND ')}` : '';
  const expenses = db.prepare(`SELECT id, amount_cents, paid_by, shared FROM expenses WHERE shared = 1 AND paid_by IS NOT NULL ${w}`).all(...args);
  const settlements = db.prepare(`SELECT from_user, to_user, amount_cents FROM expense_settlements WHERE 1 = 1 ${w}`).all(...args);
  const map = splitsFor(db, expenses.map((e) => e.id));
  const acc = new Map(users.map((u) => [u.id, { id: u.id, name: u.name, color: u.color, paid: 0, share: 0, sent: 0, received: 0, net: 0 }]));
  let totalShared = 0;
  for (const e of expenses) {
    if (!acc.has(e.paid_by)) continue;
    totalShared += e.amount_cents;
    acc.get(e.paid_by).paid += e.amount_cents;
    for (const s of expenseShares(e, map.get(e.id), defaults)) if (acc.has(s.userId)) acc.get(s.userId).share += s.cents;
  }
  for (const s of settlements) {
    if (acc.has(s.from_user)) acc.get(s.from_user).sent += s.amount_cents;
    if (acc.has(s.to_user)) acc.get(s.to_user).received += s.amount_cents;
  }
  const list = [...acc.values()];
  for (const u of list) u.net = u.paid - u.share + u.sent - u.received;
  return { from: from || null, to: to || null, totalShared, users: list, debts: simplifyDebts(list) };
}

export function balanceMessage(b) {
  if (!b.debts.length) return 'Estáis en paz: nadie debe nada.';
  return b.debts.map((d) => `${d.fromName} debe ${formatEuros(d.amount_cents)} a ${d.toName}`).join('; ') + '.';
}

// ---------- Liquidaciones ----------

const getSettlement = (db, id) => db.prepare(`SELECT s.*, f.name AS from_name, t.name AS to_name FROM expense_settlements s
  JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user WHERE s.id = ?`).get(id);

function userId(db, v) {
  if (v === undefined || v === null || v === '') return null;
  const u = db.prepare('SELECT id FROM users WHERE id = ? OR lower(name) = lower(?)').get(Number(v) || -1, String(v));
  if (!u) throw bad('Miembro no encontrado');
  return u.id;
}

function settlementFields(db, b, current = {}) {
  const from = b.from ?? b.fromUserId ?? b.from_user;
  const to = b.to ?? b.toUserId ?? b.to_user;
  const out = {
    from_user: from !== undefined ? userId(db, from) : current.from_user,
    to_user: to !== undefined ? userId(db, to) : current.to_user,
    amount_cents: current.amount_cents, date: current.date, notes: current.notes ?? '',
  };
  if (b.amount !== undefined || b.amount_cents !== undefined) {
    const c = b.amount !== undefined ? parseAmountToCents(b.amount) : Number(b.amount_cents);
    if (!Number.isInteger(c) || c <= 0) throw bad('Importe no válido');
    out.amount_cents = c;
  }
  if (b.date !== undefined) {
    if (!isDate(String(b.date).slice(0, 10))) throw bad('Fecha no válida');
    out.date = String(b.date).slice(0, 10);
  }
  if (b.notes !== undefined) out.notes = String(b.notes);
  if (!out.from_user || !out.to_user) throw bad('Indica quién paga y quién recibe');
  if (out.from_user === out.to_user) throw bad('Quien paga y quien recibe deben ser distintos');
  if (!out.amount_cents) throw bad('Importe no válido');
  return out;
}

// ---------- Rutas ----------

/** Rutas del reparto. Se registran antes de /:id para que no las capture. */
export function splitRoutes(r, db, { today }) {
  r.get('/balances', (req, res) => res.json(balances(db, { from: req.query.from, to: req.query.to })));

  r.get('/split-settings', (req, res) => res.json(publicSettings(db)));
  r.put('/split-settings', (req, res) => { saveSettings(db, req.body); res.json(publicSettings(db)); });

  r.get('/settlements', (req, res) => {
    const { from, to } = req.query;
    const where = [], args = [];
    if (from) { if (!isDate(from)) throw bad('from debe ser YYYY-MM-DD'); where.push('s.date >= ?'); args.push(from); }
    if (to) { if (!isDate(to)) throw bad('to debe ser YYYY-MM-DD'); where.push('s.date <= ?'); args.push(to); }
    res.json(db.prepare(`SELECT s.*, f.name AS from_name, t.name AS to_name FROM expense_settlements s
      JOIN users f ON f.id = s.from_user JOIN users t ON t.id = s.to_user
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.date DESC, s.id DESC LIMIT 500`).all(...args));
  });
  r.post('/settlements', (req, res) => {
    const b = req.body || {};
    const f = settlementFields(db, b, { from_user: req.user.id, date: today() });
    const id = Number(db.prepare('INSERT INTO expense_settlements (from_user, to_user, amount_cents, date, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.from_user, f.to_user, f.amount_cents, f.date, f.notes, req.user.id).lastInsertRowid);
    res.status(201).json(getSettlement(db, id));
  });
  r.get('/settlements/:id', (req, res) => {
    const s = getSettlement(db, intId(req.params.id));
    if (!s) throw notFound();
    res.json(s);
  });
  r.patch('/settlements/:id', (req, res) => {
    const id = intId(req.params.id);
    const cur = getSettlement(db, id);
    if (!cur) throw notFound();
    const f = settlementFields(db, req.body || {}, cur);
    db.prepare('UPDATE expense_settlements SET from_user = ?, to_user = ?, amount_cents = ?, date = ?, notes = ? WHERE id = ?')
      .run(f.from_user, f.to_user, f.amount_cents, f.date, f.notes, id);
    res.json(getSettlement(db, id));
  });
  r.delete('/settlements/:id', (req, res) => {
    db.prepare('DELETE FROM expense_settlements WHERE id = ?').run(intId(req.params.id));
    res.json({ ok: true });
  });
}

/** Aplica shared/personal y splits de un cuerpo de petición a un gasto (dentro de una transacción). */
export function applySplitInput(db, expenseId, data, { isNew = false } = {}) {
  const shared = sharedFromInput(data);
  if (shared !== undefined) db.prepare('UPDATE expenses SET shared = ? WHERE id = ?').run(shared, expenseId);
  const isShared = db.prepare('SELECT shared FROM expenses WHERE id = ?').get(expenseId)?.shared;
  if (!isShared) saveSplits(db, expenseId, []);
  else if (data.splits !== undefined) saveSplits(db, expenseId, normalizeSplits(db, data.splits));
  if (!isNew || data.splits !== undefined) checkSplitTotal(db, expenseId);
}
