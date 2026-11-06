import { bad, intId, notFound } from '../../core/http.js';
import { NOW } from '../../core/db.js';
import { splitItems, parseItem } from '../../lib/parse.js';

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

async function findList(db, name) {
  if (name) {
    const lists = await db.all('SELECT * FROM shopping_lists');
    const l = lists.find((x) => norm(x.name) === norm(String(name)));
    if (l) return l;
  }
  return db.get('SELECT * FROM shopping_lists ORDER BY position, id LIMIT 1');
}

/** Añade elementos a una lista. Si ya existe uno pendiente con el mismo nombre no se duplica. */
export async function addItems(db, { listId, text, user }) {
  const added = [], skipped = [];
  const pending = await db.all('SELECT id, name FROM shopping_items WHERE list_id = ? AND checked = 0', listId);
  const existing = new Map(pending.map((x) => [norm(x.name), x]));
  for (const raw of splitItems(text)) {
    const { name, quantity } = parseItem(raw);
    if (!name) continue;
    const prev = existing.get(norm(name));
    if (prev) {
      if (quantity) await db.run('UPDATE shopping_items SET quantity = ? WHERE id = ?', quantity, prev.id);
      skipped.push(name);
      continue;
    }
    const id = await db.insert('INSERT INTO shopping_items (list_id, name, quantity, added_by) VALUES (?, ?, ?, ?)', listId, name, quantity, user?.id ?? null);
    existing.set(norm(name), { id, name });
    added.push(quantity ? `${quantity} ${name}` : name);
  }
  return { added, skipped };
}

const listItems = async (db, listId) => (await db.all(`
  SELECT i.*, u.name AS added_by_name FROM shopping_items i LEFT JOIN users u ON u.id = i.added_by
  WHERE i.list_id = ? ORDER BY i.checked, i.position, i.id`, listId))
  .map((i) => ({ ...i, checked: !!i.checked }));

const joinEs = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr.at(-1)}`;

export default {
  id: 'shopping',
  name: 'Lista de la compra',
  icon: '🛒',
  migrations: [
    `CREATE TABLE shopping_lists (
       id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '🛒',
       position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (${NOW}));
     CREATE TABLE shopping_items (
       id SERIAL PRIMARY KEY,
       list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
       name TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
       checked INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0,
       added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (${NOW}), checked_at TEXT);
     CREATE INDEX idx_shopping_items_list ON shopping_items(list_id, checked);
     INSERT INTO shopping_lists (name, icon, position) VALUES ('Supermercado', '🛒', 0);`,
  ],

  routes(r, { db }) {
    r.get('/lists', async (req, res) => res.json(await db.all(`
      SELECT l.*, (SELECT COUNT(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked = 0) AS pending
      FROM shopping_lists l ORDER BY position, id`)));
    r.post('/lists', async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Falta el nombre');
      const { p } = await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shopping_lists');
      const id = await db.insert('INSERT INTO shopping_lists (name, icon, position) VALUES (?, ?, ?)', name, req.body?.icon || '🛒', p);
      res.status(201).json(await db.get('SELECT * FROM shopping_lists WHERE id = ?', id));
    });
    r.patch('/lists/:id', async (req, res) => {
      const id = intId(req.params.id);
      const { name, icon } = req.body || {};
      if (name) await db.run('UPDATE shopping_lists SET name = ? WHERE id = ?', String(name).trim(), id);
      if (icon) await db.run('UPDATE shopping_lists SET icon = ? WHERE id = ?', String(icon), id);
      res.json(await db.get('SELECT * FROM shopping_lists WHERE id = ?', id));
    });
    r.delete('/lists/:id', async (req, res) => {
      const id = intId(req.params.id);
      if ((await db.get('SELECT COUNT(*) AS n FROM shopping_lists')).n <= 1) throw bad('Debe quedar al menos una lista');
      await db.run('DELETE FROM shopping_lists WHERE id = ?', id);
      res.json({ ok: true });
    });

    r.get('/lists/:id/items', async (req, res) => res.json(await listItems(db, intId(req.params.id))));
    r.post('/lists/:id/items', async (req, res) => {
      const listId = intId(req.params.id);
      if (!await db.get('SELECT 1 FROM shopping_lists WHERE id = ?', listId)) throw notFound('Lista no encontrada');
      const text = req.body?.text ?? req.body?.name ?? req.body?.items;
      if (!text) throw bad('Falta el texto');
      res.status(201).json(await addItems(db, { listId, text, user: req.user }));
    });
    r.patch('/items/:id', async (req, res) => {
      const id = intId(req.params.id);
      const it = await db.get('SELECT * FROM shopping_items WHERE id = ?', id);
      if (!it) throw notFound();
      const b = req.body || {};
      if (b.name !== undefined) await db.run('UPDATE shopping_items SET name = ? WHERE id = ?', String(b.name).trim(), id);
      if (b.quantity !== undefined) await db.run('UPDATE shopping_items SET quantity = ? WHERE id = ?', String(b.quantity), id);
      if (b.notes !== undefined) await db.run('UPDATE shopping_items SET notes = ? WHERE id = ?', String(b.notes), id);
      if (b.listId !== undefined) await db.run('UPDATE shopping_items SET list_id = ? WHERE id = ?', intId(b.listId), id);
      if (b.checked !== undefined) {
        await db.run(`UPDATE shopping_items SET checked = ?, checked_at = ${b.checked ? NOW : 'NULL'} WHERE id = ?`, b.checked ? 1 : 0, id);
      }
      res.json({ ...await db.get('SELECT * FROM shopping_items WHERE id = ?', id) });
    });
    r.delete('/items/:id', async (req, res) => {
      await db.run('DELETE FROM shopping_items WHERE id = ?', intId(req.params.id));
      res.json({ ok: true });
    });
    r.post('/lists/:id/clear-checked', async (req, res) => {
      const { changes } = await db.run('DELETE FROM shopping_items WHERE list_id = ? AND checked = 1', intId(req.params.id));
      res.json({ ok: true, deleted: Number(changes) });
    });
    // Sugerencias: productos comprados anteriormente (para autocompletar)
    r.get('/suggestions', async (req, res) => {
      res.json((await db.all('SELECT MIN(name) AS name, COUNT(*) AS n FROM shopping_items GROUP BY lower(name) ORDER BY n DESC, name LIMIT 200')).map((x) => x.name));
    });
  },

  quick: {
    shopping: {
      description: 'Añade productos a la lista de la compra. Separa con comas o "y".',
      params: { text: 'Productos, p.ej. "leche, 2 huevos y pan"', list: '(opcional) nombre de la lista' },
      async handler({ db }, p, user) {
        const text = p.text ?? p.items ?? p.item ?? p.name;
        if (!text || !String(text).trim()) throw bad('Dime qué quieres añadir');
        const list = await findList(db, p.list);
        const { added, skipped } = await addItems(db, { listId: list.id, text, user });
        let message = added.length ? `Añadido a ${list.name}: ${joinEs(added)}.` : '';
        if (skipped.length) message += `${message ? ' ' : ''}Ya estaba en la lista: ${joinEs(skipped)}.`;
        return { message: message || 'No se añadió nada.', list: list.name, added, skipped };
      },
    },
    'shopping-list': {
      description: 'Devuelve lo pendiente de la lista (para que Siri lo lea).',
      params: { list: '(opcional) nombre de la lista' },
      async handler({ db }, p) {
        const list = await findList(db, p.list);
        const items = (await listItems(db, list.id)).filter((i) => !i.checked);
        const names = items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
        return {
          message: names.length ? `En ${list.name} hay ${names.length}: ${joinEs(names)}.` : `La lista ${list.name} está vacía.`,
          list: list.name, items: names,
        };
      },
    },
  },

  async summary({ db }) {
    const { n } = await db.get('SELECT COUNT(*) AS n FROM shopping_items WHERE checked = 0');
    return { title: 'Compra', value: `${n}`, subtitle: n === 1 ? 'producto pendiente' : 'productos pendientes', href: '#/shopping' };
  },
};
