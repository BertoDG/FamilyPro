import { bad, intId, notFound } from '../../core/http.js';
import { splitItems, parseItem } from '../../lib/parse.js';

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

function findList(db, name) {
  if (name) {
    const lists = db.prepare('SELECT * FROM shopping_lists').all();
    const l = lists.find((x) => norm(x.name) === norm(String(name)));
    if (l) return l;
  }
  return db.prepare('SELECT * FROM shopping_lists ORDER BY position, id LIMIT 1').get();
}

/** Añade elementos a una lista. Si ya existe uno pendiente con el mismo nombre no se duplica. */
export function addItems(db, { listId, text, user }) {
  const added = [], skipped = [];
  const pending = db.prepare('SELECT id, name FROM shopping_items WHERE list_id = ? AND checked = 0').all(listId);
  const existing = new Map(pending.map((x) => [norm(x.name), x]));
  const ins = db.prepare('INSERT INTO shopping_items (list_id, name, quantity, added_by) VALUES (?, ?, ?, ?)');
  for (const raw of splitItems(text)) {
    const { name, quantity } = parseItem(raw);
    if (!name) continue;
    const prev = existing.get(norm(name));
    if (prev) {
      if (quantity) db.prepare('UPDATE shopping_items SET quantity = ? WHERE id = ?').run(quantity, prev.id);
      skipped.push(name);
      continue;
    }
    const r = ins.run(listId, name, quantity, user?.id ?? null);
    existing.set(norm(name), { id: Number(r.lastInsertRowid), name });
    added.push(quantity ? `${quantity} ${name}` : name);
  }
  return { added, skipped };
}

const listItems = (db, listId) => db.prepare(`
  SELECT i.*, u.name AS added_by_name FROM shopping_items i LEFT JOIN users u ON u.id = i.added_by
  WHERE i.list_id = ? ORDER BY i.checked, i.position, i.id`).all(listId)
  .map((i) => ({ ...i, checked: !!i.checked }));

const joinEs = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr.at(-1)}`;

export default {
  id: 'shopping',
  name: 'Lista de la compra',
  icon: '🛒',
  migrations: [
    `CREATE TABLE shopping_lists (
       id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🛒',
       position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
     CREATE TABLE shopping_items (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
       name TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
       checked INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
       added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), checked_at TEXT);
     CREATE INDEX idx_shopping_items_list ON shopping_items(list_id, checked);
     INSERT INTO shopping_lists (name, icon, position) VALUES ('Supermercado', '🛒', 0);`,
  ],

  routes(r, { db }) {
    r.get('/lists', (req, res) => res.json(db.prepare(`
      SELECT l.*, (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 0) AS pending
      FROM shopping_lists l ORDER BY position, id`).all()));
    r.post('/lists', (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Falta el nombre');
      const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shopping_lists').get().p;
      const id = Number(db.prepare('INSERT INTO shopping_lists (name, icon, position) VALUES (?, ?, ?)').run(name, req.body?.icon || '🛒', pos).lastInsertRowid);
      res.status(201).json(db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(id));
    });
    r.patch('/lists/:id', (req, res) => {
      const id = intId(req.params.id);
      const { name, icon } = req.body || {};
      if (name) db.prepare('UPDATE shopping_lists SET name = ? WHERE id = ?').run(String(name).trim(), id);
      if (icon) db.prepare('UPDATE shopping_lists SET icon = ? WHERE id = ?').run(String(icon), id);
      res.json(db.prepare('SELECT * FROM shopping_lists WHERE id = ?').get(id));
    });
    r.delete('/lists/:id', (req, res) => {
      const id = intId(req.params.id);
      if (db.prepare('SELECT COUNT(*) AS n FROM shopping_lists').get().n <= 1) throw bad('Debe quedar al menos una lista');
      db.prepare('DELETE FROM shopping_lists WHERE id = ?').run(id);
      res.json({ ok: true });
    });

    r.get('/lists/:id/items', (req, res) => res.json(listItems(db, intId(req.params.id))));
    r.post('/lists/:id/items', (req, res) => {
      const listId = intId(req.params.id);
      if (!db.prepare('SELECT 1 FROM shopping_lists WHERE id = ?').get(listId)) throw notFound('Lista no encontrada');
      const text = req.body?.text ?? req.body?.name ?? req.body?.items;
      if (!text) throw bad('Falta el texto');
      res.status(201).json(addItems(db, { listId, text, user: req.user }));
    });
    r.patch('/items/:id', (req, res) => {
      const id = intId(req.params.id);
      const it = db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id);
      if (!it) throw notFound();
      const b = req.body || {};
      if (b.name !== undefined) db.prepare('UPDATE shopping_items SET name = ? WHERE id = ?').run(String(b.name).trim(), id);
      if (b.quantity !== undefined) db.prepare('UPDATE shopping_items SET quantity = ? WHERE id = ?').run(String(b.quantity), id);
      if (b.notes !== undefined) db.prepare('UPDATE shopping_items SET notes = ? WHERE id = ?').run(String(b.notes), id);
      if (b.listId !== undefined) db.prepare('UPDATE shopping_items SET list_id = ? WHERE id = ?').run(intId(b.listId), id);
      if (b.checked !== undefined) {
        db.prepare("UPDATE shopping_items SET checked = ?, checked_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?")
          .run(b.checked ? 1 : 0, b.checked ? 1 : 0, id);
      }
      res.json({ ...db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id) });
    });
    r.delete('/items/:id', (req, res) => {
      db.prepare('DELETE FROM shopping_items WHERE id = ?').run(intId(req.params.id));
      res.json({ ok: true });
    });
    r.post('/lists/:id/clear-checked', (req, res) => {
      const n = db.prepare('DELETE FROM shopping_items WHERE list_id = ? AND checked = 1').run(intId(req.params.id)).changes;
      res.json({ ok: true, deleted: Number(n) });
    });
    // Sugerencias: productos comprados anteriormente (para autocompletar)
    r.get('/suggestions', (req, res) => {
      res.json(db.prepare(`SELECT name, COUNT(*) AS n FROM shopping_items GROUP BY lower(name) ORDER BY n DESC LIMIT 200`).all().map((x) => x.name));
    });
  },

  quick: {
    shopping: {
      description: 'Añade productos a la lista de la compra. Separa con comas o "y".',
      params: { text: 'Productos, p.ej. "leche, 2 huevos y pan"', list: '(opcional) nombre de la lista' },
      handler({ db }, p, user) {
        const text = p.text ?? p.items ?? p.item ?? p.name;
        if (!text || !String(text).trim()) throw bad('Dime qué quieres añadir');
        const list = findList(db, p.list);
        const { added, skipped } = addItems(db, { listId: list.id, text, user });
        let message = added.length ? `Añadido a ${list.name}: ${joinEs(added)}.` : '';
        if (skipped.length) message += `${message ? ' ' : ''}Ya estaba en la lista: ${joinEs(skipped)}.`;
        return { message: message || 'No se añadió nada.', list: list.name, added, skipped };
      },
    },
    'shopping-list': {
      description: 'Devuelve lo pendiente de la lista (para que Siri lo lea).',
      params: { list: '(opcional) nombre de la lista' },
      handler({ db }, p) {
        const list = findList(db, p.list);
        const items = listItems(db, list.id).filter((i) => !i.checked);
        const names = items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
        return {
          message: names.length ? `En ${list.name} hay ${names.length}: ${joinEs(names)}.` : `La lista ${list.name} está vacía.`,
          list: list.name, items: names,
        };
      },
    },
  },

  summary({ db }) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM shopping_items WHERE checked = 0').get().n;
    return { title: 'Compra', value: `${n}`, subtitle: n === 1 ? 'producto pendiente' : 'productos pendientes', href: '#/shopping' };
  },
};
