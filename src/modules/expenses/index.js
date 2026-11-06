import { bad, intId, notFound } from '../../core/http.js';
import { parseAmountToCents, parseExpenseText, formatEuros, capitalize } from '../../lib/parse.js';
import { isDate, today } from '../../lib/dates.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

const DEFAULT_CATEGORIES = [
  ['Supermercado', '🛒', '#22a06b', 'mercadona,carrefour,lidl,dia,aldi,eroski,alcampo,hipercor,consum,bonpreu,ahorramas,supermercado,super,fruteria,carniceria,panaderia'],
  ['Restaurantes', '🍽️', '#e8833a', 'restaurante,bar,cafeteria,cafe,mcdonald,burger,telepizza,glovo,just eat,uber eats,starbucks,cena,comida fuera'],
  ['Transporte', '🚗', '#3b82f6', 'gasolina,gasolinera,repsol,cepsa,galp,bp,shell,renfe,metro,bus,taxi,uber,cabify,parking,peaje,itv'],
  ['Hogar', '🏠', '#8b5cf6', 'ikea,leroy,bricomart,ferreteria,limpieza,muebles,amazon'],
  ['Suministros', '💡', '#eab308', 'luz,agua,gas,internet,iberdrola,endesa,naturgy,vodafone,movistar,orange,digi,telefono,alquiler,hipoteca,comunidad'],
  ['Salud', '💊', '#ef4444', 'farmacia,medico,dentista,optica,hospital,clinica,seguro medico'],
  ['Ocio', '🎉', '#ec4899', 'cine,netflix,spotify,hbo,disney,teatro,concierto,viaje,hotel,airbnb,juguetes'],
  ['Ropa', '👕', '#14b8a6', 'zara,primark,decathlon,h&m,mango,ropa,zapatos,calzado'],
  ['Educación', '📚', '#0ea5e9', 'colegio,libros,academia,matricula,guarderia,material escolar'],
  ['Otros', '📦', '#64748b', ''],
];

function categories(db) {
  return db.prepare('SELECT * FROM expense_categories ORDER BY position, id').all();
}

/** Busca categoría: por nombre explícito, por comercio ya usado antes, o por palabras clave. */
export function guessCategory(db, { category, merchant, description }) {
  const cats = categories(db);
  if (category) {
    const c = cats.find((x) => norm(x.name) === norm(category) || String(x.id) === String(category));
    if (c) return c.id;
  }
  if (merchant) {
    const prev = db.prepare('SELECT category_id FROM expenses WHERE lower(merchant) = lower(?) AND category_id IS NOT NULL ORDER BY id DESC LIMIT 1').get(merchant);
    if (prev) return prev.category_id;
  }
  const hay = ` ${norm(`${merchant || ''} ${description || ''}`)} `;
  for (const c of cats) {
    for (const k of c.keywords.split(',').map(norm).filter(Boolean)) {
      if (hay.includes(` ${k} `) || hay.includes(` ${k}`) && k.length > 3) return c.id;
    }
  }
  return cats.find((c) => norm(c.name) === 'otros')?.id ?? cats[0]?.id ?? null;
}

function resolveUser(db, v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const u = db.prepare('SELECT id FROM users WHERE id = ? OR lower(name) = lower(?)').get(Number(v) || -1, String(v));
  return u ? u.id : fallback;
}

export function createExpense(db, data, user) {
  const cents = data.cents ?? parseAmountToCents(data.amount);
  if (cents === null || cents === undefined || Number.isNaN(cents)) throw bad('Importe no válido');
  const date = data.date && isDate(String(data.date).slice(0, 10)) ? String(data.date).slice(0, 10) : today();
  const merchant = data.merchant ? capitalize(String(data.merchant).trim()) : '';
  const description = String(data.description ?? '').trim() || merchant || 'Gasto';
  const categoryId = guessCategory(db, { category: data.category ?? data.categoryId, merchant, description });
  const paidBy = resolveUser(db, data.paidBy, user?.id ?? null);
  const r = db.prepare(`INSERT INTO expenses (amount_cents, description, merchant, category_id, paid_by, date, source, card, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Math.abs(cents), description, merchant, categoryId, paidBy, date, String(data.source || 'web'), String(data.card || ''), String(data.notes || ''), user?.id ?? null);
  return getExpense(db, Number(r.lastInsertRowid));
}

function getExpense(db, id) {
  return db.prepare(`SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, u.name AS paid_by_name
    FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.paid_by WHERE e.id = ?`).get(id);
}

const monthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(month)) throw bad('month debe ser YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, '0')}`];
};

function summary(db, month) {
  const [from, to] = monthRange(month);
  const total = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t, COUNT(*) AS n FROM expenses WHERE date BETWEEN ? AND ?').get(from, to);
  const byCategory = db.prepare(`SELECT c.id, c.name, c.icon, c.color, c.budget_cents, COALESCE(SUM(e.amount_cents),0) AS total, COUNT(e.id) AS count
    FROM expense_categories c LEFT JOIN expenses e ON e.category_id = c.id AND e.date BETWEEN ? AND ?
    GROUP BY c.id HAVING total > 0 OR c.budget_cents > 0 ORDER BY total DESC`).all(from, to);
  const byUser = db.prepare(`SELECT u.id, u.name, u.color, COALESCE(SUM(e.amount_cents),0) AS total
    FROM users u LEFT JOIN expenses e ON e.paid_by = u.id AND e.date BETWEEN ? AND ? GROUP BY u.id ORDER BY total DESC`).all(from, to);
  const byDay = db.prepare('SELECT date, SUM(amount_cents) AS total FROM expenses WHERE date BETWEEN ? AND ? GROUP BY date ORDER BY date').all(from, to);
  // Comparativa con los 6 meses anteriores
  const [y, m] = month.split('-').map(Number);
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const [f, t] = monthRange(key);
    history.push({ month: key, total: db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS t FROM expenses WHERE date BETWEEN ? AND ?').get(f, t).t });
  }
  return { month, from, to, total: total.t, count: total.n, byCategory, byUser, byDay, history };
}

export default {
  id: 'expenses',
  name: 'Gastos',
  icon: '💶',
  migrations: [
    (db) => {
      db.exec(`CREATE TABLE expense_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, icon TEXT NOT NULL DEFAULT '📦',
          color TEXT NOT NULL DEFAULT '#64748b', keywords TEXT NOT NULL DEFAULT '', budget_cents INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT, amount_cents INTEGER NOT NULL, description TEXT NOT NULL,
          merchant TEXT NOT NULL DEFAULT '', category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
          paid_by INTEGER REFERENCES users(id) ON DELETE SET NULL, date TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'web', card TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
        CREATE INDEX idx_expenses_date ON expenses(date);`);
      const ins = db.prepare('INSERT INTO expense_categories (name, icon, color, keywords, position) VALUES (?, ?, ?, ?, ?)');
      DEFAULT_CATEGORIES.forEach(([n, i, c, k], idx) => ins.run(n, i, c, k, idx));
    },
  ],

  routes(r, { db }) {
    r.get('/categories', (req, res) => res.json(categories(db)));
    r.post('/categories', (req, res) => {
      const b = req.body || {};
      if (!b.name?.trim()) throw bad('Falta el nombre');
      const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 AS p FROM expense_categories').get().p;
      const id = Number(db.prepare('INSERT INTO expense_categories (name, icon, color, keywords, budget_cents, position) VALUES (?, ?, ?, ?, ?, ?)')
        .run(b.name.trim(), b.icon || '📦', b.color || '#64748b', b.keywords || '', parseAmountToCents(b.budget) || 0, pos).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id));
    });
    r.patch('/categories/:id', (req, res) => {
      const id = intId(req.params.id);
      const b = req.body || {};
      for (const f of ['name', 'icon', 'color', 'keywords']) {
        if (b[f] !== undefined) db.prepare(`UPDATE expense_categories SET ${f} = ? WHERE id = ?`).run(String(b[f]), id);
      }
      if (b.budget !== undefined) db.prepare('UPDATE expense_categories SET budget_cents = ? WHERE id = ?').run(parseAmountToCents(b.budget) || 0, id);
      res.json(db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(id));
    });
    r.delete('/categories/:id', (req, res) => {
      db.prepare('DELETE FROM expense_categories WHERE id = ?').run(intId(req.params.id));
      res.json({ ok: true });
    });

    r.get('/', (req, res) => {
      const { month, from, to, category, q, paidBy } = req.query;
      const where = [], args = [];
      if (month) { const [f, t] = monthRange(month); where.push('e.date BETWEEN ? AND ?'); args.push(f, t); }
      if (from) { where.push('e.date >= ?'); args.push(from); }
      if (to) { where.push('e.date <= ?'); args.push(to); }
      if (category) { where.push('e.category_id = ?'); args.push(intId(category)); }
      if (paidBy) { where.push('e.paid_by = ?'); args.push(intId(paidBy)); }
      if (q) { where.push('(e.description LIKE ? OR e.merchant LIKE ? OR e.notes LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
      res.json(db.prepare(`SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, u.name AS paid_by_name
        FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.paid_by
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date DESC, e.id DESC LIMIT 1000`).all(...args));
    });
    r.post('/', (req, res) => res.status(201).json(createExpense(db, { ...req.body, source: req.body?.source || 'web' }, req.user)));
    r.get('/summary', (req, res) => res.json(summary(db, req.query.month || today().slice(0, 7))));
    r.get('/export.csv', (req, res) => {
      const rows = db.prepare(`SELECT e.date, e.amount_cents, e.description, e.merchant, c.name AS category, u.name AS paid_by, e.source, e.card, e.notes
        FROM expenses e LEFT JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.paid_by ORDER BY e.date`).all();
      const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = ['fecha;importe;descripcion;comercio;categoria;pagado_por;origen;tarjeta;notas',
        ...rows.map((x) => [x.date, (x.amount_cents / 100).toFixed(2).replace('.', ','), x.description, x.merchant, x.category, x.paid_by, x.source, x.card, x.notes].map(q).join(';'))].join('\n');
      res.type('text/csv; charset=utf-8').attachment('gastos.csv').send('﻿' + csv);
    });
    r.get('/:id', (req, res) => {
      const e = getExpense(db, intId(req.params.id));
      if (!e) throw notFound();
      res.json(e);
    });
    r.patch('/:id', (req, res) => {
      const id = intId(req.params.id);
      if (!getExpense(db, id)) throw notFound();
      const b = req.body || {};
      if (b.amount !== undefined) {
        const c = parseAmountToCents(b.amount);
        if (c === null) throw bad('Importe no válido');
        db.prepare('UPDATE expenses SET amount_cents = ? WHERE id = ?').run(Math.abs(c), id);
      }
      for (const f of ['description', 'merchant', 'notes', 'card']) {
        if (b[f] !== undefined) db.prepare(`UPDATE expenses SET ${f} = ? WHERE id = ?`).run(String(b[f]), id);
      }
      if (b.date !== undefined) {
        if (!isDate(b.date)) throw bad('Fecha no válida');
        db.prepare('UPDATE expenses SET date = ? WHERE id = ?').run(b.date, id);
      }
      if (b.categoryId !== undefined) db.prepare('UPDATE expenses SET category_id = ? WHERE id = ?').run(b.categoryId ? intId(b.categoryId) : null, id);
      if (b.paidBy !== undefined) db.prepare('UPDATE expenses SET paid_by = ? WHERE id = ?').run(b.paidBy ? intId(b.paidBy) : null, id);
      res.json(getExpense(db, id));
    });
    r.delete('/:id', (req, res) => {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(intId(req.params.id));
      res.json({ ok: true });
    });
  },

  quick: {
    expense: {
      description: 'Registra un gasto. Ideal para la automatización de Wallet (importe + comercio) o para Siri ("12,50 en Mercadona").',
      params: {
        amount: 'Importe ("12,50 €", 12.5...)', merchant: '(opcional) comercio', description: '(opcional) concepto',
        category: '(opcional) nombre de categoría', card: '(opcional) tarjeta', date: '(opcional) YYYY-MM-DD',
        paidBy: '(opcional) nombre de quien paga', text: 'Alternativa: texto libre "12,50 mercadona"', source: '(opcional) wallet | siri | shortcut',
      },
      handler({ db }, p, user) {
        let data = { ...p };
        if ((p.amount === undefined || p.amount === '') && p.text) {
          const parsed = parseExpenseText(p.text);
          data = { ...data, cents: parsed.cents, description: p.description || capitalize(parsed.text) };
        }
        if (data.cents == null && parseAmountToCents(data.amount) === null) throw bad('No he entendido el importe');
        const e = createExpense(db, { ...data, source: p.source || (p.merchant ? 'wallet' : 'shortcut') }, user);
        const monthTotal = summary(db, e.date.slice(0, 7));
        const cat = monthTotal.byCategory.find((c) => c.id === e.category_id);
        let message = `Gasto de ${formatEuros(e.amount_cents)} en ${e.description} (${e.category_name || 'sin categoría'}).`;
        if (cat?.budget_cents) message += ` Llevas ${formatEuros(cat.total)} de ${formatEuros(cat.budget_cents)} este mes.`;
        return { message, expense: e };
      },
    },
  },

  calendar: {
    label: 'Gastos',
    color: '#e8833a',
    defaultVisible: false,
    fetch({ db }, { from, to }) {
      return db.prepare(`SELECT e.id, e.date, e.amount_cents, e.description, c.icon, c.color FROM expenses e
        LEFT JOIN expense_categories c ON c.id = e.category_id WHERE e.date BETWEEN ? AND ? ORDER BY e.date`).all(from, to)
        .map((e) => ({
          id: `expense-${e.id}`, title: `${e.icon || '💶'} ${formatEuros(e.amount_cents)} · ${e.description}`,
          start: e.date, end: e.date, allDay: true, color: e.color || undefined, href: '#/expenses',
        }));
    },
  },

  summary({ db }) {
    const s = summary(db, today().slice(0, 7));
    return { title: 'Gastos del mes', value: formatEuros(s.total), subtitle: `${s.count} movimientos`, href: '#/expenses' };
  },
};
