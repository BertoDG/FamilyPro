import { bad, intId, notFound } from '../../core/http.js';
import { transaction } from '../../core/db.js';
import { isDate, toUTC, addDays, fmtDate, today, nowLocal } from '../../lib/dates.js';
import { parseSpanishDate } from '../../lib/nlp-date.js';
import { parseItem, capitalize } from '../../lib/parse.js';
import { addItems } from '../shopping/index.js';

/** Tipos de comida, en el orden en que se muestran. */
export const MEALS = ['desayuno', 'comida', 'merienda', 'cena'];
const LABEL = { desayuno: 'Desayuno', comida: 'Comida', merienda: 'Merienda', cena: 'Cena' };
const FOR = { desayuno: 'para desayunar', comida: 'para comer', merienda: 'para merendar', cena: 'para cenar' };
const ALIASES = {
  desayuno: 'desayuno', desayunar: 'desayuno', breakfast: 'desayuno',
  comida: 'comida', comer: 'comida', almuerzo: 'comida', almorzar: 'comida', lunch: 'comida',
  merienda: 'merienda', merendar: 'merienda', snack: 'merienda',
  cena: 'cena', cenar: 'cena', dinner: 'cena',
};

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const joinEs = (arr) => arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} y ${arr.at(-1)}`;
const dayLabel = (date) => {
  const t = today();
  if (date === t) return 'hoy';
  if (date === fmtDate(addDays(toUTC(t), 1))) return 'mañana';
  return `el ${toUTC(date).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
};

export const mealKey = (v) => ALIASES[norm(v)] || null;

/** Busca una palabra de comida en un texto ("mañana para cenar lasaña") y la quita. */
function extractMeal(text) {
  const re = /(?:^|\s)(?:(?:para|de|en|el|la|a la|en la|en el)\s+)*(desayuno|desayunar|comida|comer|almuerzo|almorzar|merienda|merendar|cena|cenar)(?=\s|$|[,.:])/i;
  const m = String(text).match(re);
  if (!m) return { meal: null, rest: String(text) };
  return { meal: ALIASES[m[1].toLowerCase()], rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^[\s,:.]+|[\s,:.]+$/g, '') };
}

/** Normaliza ingredientes: array de {name, quantity} o de líneas "2 cebollas", o texto con una línea por ingrediente. */
function normIngredients(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split('\n');
  return arr.map((x) => {
    if (x && typeof x === 'object') return { name: capitalize(String(x.name ?? '').trim()), quantity: String(x.quantity ?? '').trim() };
    const s = String(x ?? '').trim().replace(/^[-*•·]\s*/, '');
    return s ? parseItem(s) : { name: '' };
  }).filter((x) => x.name);
}

const normTags = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((t) => String(t).trim().toLowerCase()).filter(Boolean))];

const rowToRecipe = (db, r) => r && ({
  ...r, tags: parseJSON(r.tags, []),
  ingredients: db.prepare('SELECT name, quantity FROM meal_ingredients WHERE recipe_id = ? ORDER BY position, id').all(r.id),
});
const getRecipe = (db, id) => rowToRecipe(db, db.prepare('SELECT * FROM meal_recipes WHERE id = ?').get(id));

function saveRecipe(db, b, id = null) {
  const cur = id ? getRecipe(db, id) : {};
  if (id && !cur) throw notFound('Receta no encontrada');
  const name = String(b.name ?? cur.name ?? '').trim();
  if (!name) throw bad('Falta el nombre de la receta');
  const servings = b.servings === undefined ? (cur.servings ?? null) : (Number(b.servings) > 0 ? Math.round(Number(b.servings)) : null);
  const v = {
    name, notes: String(b.notes ?? cur.notes ?? ''), servings, url: String(b.url ?? cur.url ?? '').trim(),
    tags: JSON.stringify(b.tags === undefined ? (cur.tags ?? []) : normTags(b.tags)),
  };
  return transaction(db, () => {
    if (id) {
      db.prepare('UPDATE meal_recipes SET name = ?, notes = ?, servings = ?, url = ?, tags = ? WHERE id = ?').run(v.name, v.notes, v.servings, v.url, v.tags, id);
    } else {
      id = Number(db.prepare('INSERT INTO meal_recipes (name, notes, servings, url, tags) VALUES (?, ?, ?, ?, ?)').run(v.name, v.notes, v.servings, v.url, v.tags).lastInsertRowid);
    }
    if (b.ingredients !== undefined || !cur.id) {
      db.prepare('DELETE FROM meal_ingredients WHERE recipe_id = ?').run(id);
      const ins = db.prepare('INSERT INTO meal_ingredients (recipe_id, name, quantity, position) VALUES (?, ?, ?, ?)');
      normIngredients(b.ingredients).forEach((x, i) => ins.run(id, x.name, x.quantity || '', i));
    }
    return getRecipe(db, id);
  });
}

const planRows = (db, from, to) => db.prepare(`
  SELECT p.*, r.name AS recipe_name, u.name AS cook_name, u.color AS cook_color FROM meal_plan p
  LEFT JOIN meal_recipes r ON r.id = p.recipe_id LEFT JOIN users u ON u.id = p.cook_id
  WHERE p.date BETWEEN ? AND ?`).all(from, to)
  .map((p) => ({ ...p, title: p.recipe_name || p.text }))
  .sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));

const getSlot = (db, date, meal) => planRows(db, date, date).find((p) => p.meal === meal) || null;

function findRecipeByName(db, name) {
  const n = norm(name);
  if (!n) return null;
  return db.prepare('SELECT id, name FROM meal_recipes').all().find((r) => norm(r.name) === n) || null;
}

function setSlot(db, date, meal, b) {
  if (!isDate(date)) throw bad('Fecha no válida (YYYY-MM-DD)');
  const key = mealKey(meal);
  if (!key) throw bad(`Tipo de comida no válido (${MEALS.join(', ')})`);
  let recipeId = b.recipeId ?? b.recipe_id ?? null;
  recipeId = recipeId === null || recipeId === '' ? null : intId(recipeId);
  if (recipeId && !db.prepare('SELECT 1 FROM meal_recipes WHERE id = ?').get(recipeId)) throw notFound('Receta no encontrada');
  const text = String(b.text ?? '').trim();
  if (!recipeId && !text) throw bad('Elige una receta o escribe qué hay');
  let cookId = b.cookId ?? b.cook_id ?? null;
  cookId = cookId === null || cookId === '' ? null : intId(cookId);
  db.prepare(`INSERT INTO meal_plan (date, meal, recipe_id, text, notes, cook_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, meal) DO UPDATE SET recipe_id = excluded.recipe_id, text = excluded.text, notes = excluded.notes,
      cook_id = excluded.cook_id, updated_at = datetime('now')`)
    .run(date, key, recipeId, text, String(b.notes ?? ''), cookId);
  return getSlot(db, date, key);
}

const hasShopping = (db) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shopping_items'").get();

/** Añade a la lista de la compra los ingredientes de las recetas planificadas entre from y to. */
export function exportIngredients(db, { from, to, listId, user }) {
  if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
  if (!hasShopping(db)) throw bad('El módulo de compra no está activo');
  const list = listId
    ? db.prepare('SELECT id, name FROM shopping_lists WHERE id = ?').get(intId(listId))
    : db.prepare('SELECT id, name FROM shopping_lists ORDER BY position, id LIMIT 1').get();
  if (!list) throw notFound('Lista no encontrada');
  const recipeIds = [...new Set(planRows(db, from, to).filter((p) => p.recipe_id).map((p) => p.recipe_id))];
  const lines = recipeIds.flatMap((id) => db.prepare('SELECT name, quantity FROM meal_ingredients WHERE recipe_id = ? ORDER BY position, id').all(id))
    .map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
  const { added, skipped } = lines.length ? addItems(db, { listId: list.id, text: lines, user }) : { added: [], skipped: [] };
  let message = added.length ? `Añadido a ${list.name}: ${joinEs(added)}.` : '';
  if (skipped.length) message += `${message ? ' ' : ''}Ya estaba en la lista: ${joinEs(skipped)}.`;
  if (!message) message = recipeIds.length ? 'Las recetas planificadas no tienen ingredientes.' : 'No hay recetas planificadas en esas fechas.';
  return { message, list: list.name, listId: list.id, recipes: recipeIds.length, added, skipped };
}

function dayMessage(db, date, onlyMeal) {
  const rows = planRows(db, date, date).filter((p) => (onlyMeal ? p.meal === onlyMeal : true));
  const when = dayLabel(date);
  if (!rows.length) {
    return { message: onlyMeal ? `No hay nada planificado ${FOR[onlyMeal]} ${when}.` : `No hay nada planificado ${when}.`, date, meals: [] };
  }
  const parts = rows.map((p, i) => `${FOR[p.meal]}${i ? '' : ' hay'} ${p.title}${p.cook_name ? ` (cocina ${p.cook_name})` : ''}`);
  const message = `${capitalize(when)} ${joinEs(parts)}.`;
  return { message, date, meals: rows.map((p) => ({ meal: p.meal, title: p.title, cook: p.cook_name || null })) };
}

export default {
  id: 'meals',
  name: 'Menú semanal',
  icon: '🍽️',
  migrations: [
    `CREATE TABLE meal_recipes (
       id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', servings INTEGER,
       url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
     CREATE TABLE meal_ingredients (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       recipe_id INTEGER NOT NULL REFERENCES meal_recipes(id) ON DELETE CASCADE,
       name TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX idx_meal_ingredients_recipe ON meal_ingredients(recipe_id);
     CREATE TABLE meal_plan (
       id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
       meal TEXT NOT NULL CHECK (meal IN ('desayuno', 'comida', 'merienda', 'cena')),
       recipe_id INTEGER REFERENCES meal_recipes(id) ON DELETE SET NULL, text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
       cook_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
       UNIQUE (date, meal));`,
  ],

  routes(r, { db }) {
    // ---------- Recetas ----------
    r.get('/recipes', (req, res) => {
      const q = norm(req.query.q);
      const rows = db.prepare('SELECT * FROM meal_recipes ORDER BY name COLLATE NOCASE').all().map((x) => rowToRecipe(db, x));
      res.json(q ? rows.filter((x) => norm(`${x.name} ${x.tags.join(' ')}`).includes(q)) : rows);
    });
    r.post('/recipes', (req, res) => res.status(201).json(saveRecipe(db, req.body || {})));
    r.get('/recipes/:id', (req, res) => {
      const x = getRecipe(db, intId(req.params.id));
      if (!x) throw notFound('Receta no encontrada');
      res.json(x);
    });
    r.put('/recipes/:id', (req, res) => res.json(saveRecipe(db, req.body || {}, intId(req.params.id))));
    r.delete('/recipes/:id', (req, res) => {
      const id = intId(req.params.id);
      const x = getRecipe(db, id);
      if (!x) throw notFound('Receta no encontrada');
      transaction(db, () => {
        // Lo ya planificado conserva el nombre como texto libre
        db.prepare("UPDATE meal_plan SET text = ? WHERE recipe_id = ? AND text = ''").run(x.name, id);
        db.prepare('DELETE FROM meal_recipes WHERE id = ?').run(id);
      });
      res.json({ ok: true });
    });

    // ---------- Planificación ----------
    r.get('/plan', (req, res) => {
      const from = req.query.from || today();
      const to = req.query.to || fmtDate(addDays(toUTC(from), 6));
      if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
      if (toUTC(to) - toUTC(from) > 400 * 864e5) throw bad('Rango demasiado grande (máx. 400 días)');
      res.json(planRows(db, from, to));
    });
    r.post('/plan/shopping', (req, res) => {
      const b = req.body || {};
      res.json({ ok: true, ...exportIngredients(db, { from: b.from, to: b.to || b.from, listId: b.listId, user: req.user }) });
    });
    /** Copia el plan de 7 días que empiezan en `from` a los 7 días que empiezan en `to`. */
    r.post('/plan/copy', (req, res) => {
      const { from, to, overwrite = false } = req.body || {};
      const days = Math.min(31, Math.max(1, Number(req.body?.days) || 7));
      if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
      if (from === to) throw bad('Las semanas de origen y destino son la misma');
      const offset = Math.round((toUTC(to) - toUTC(from)) / 864e5);
      const src = planRows(db, from, fmtDate(addDays(toUTC(from), days - 1)));
      let copied = 0, skipped = 0;
      transaction(db, () => {
        const sql = overwrite
          ? `INSERT INTO meal_plan (date, meal, recipe_id, text, notes, cook_id) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(date, meal) DO UPDATE SET recipe_id = excluded.recipe_id, text = excluded.text, notes = excluded.notes,
               cook_id = excluded.cook_id, updated_at = datetime('now')`
          : 'INSERT INTO meal_plan (date, meal, recipe_id, text, notes, cook_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, meal) DO NOTHING';
        const st = db.prepare(sql);
        for (const p of src) {
          const n = st.run(fmtDate(addDays(toUTC(p.date), offset)), p.meal, p.recipe_id, p.text, p.notes, p.cook_id).changes;
          if (Number(n)) copied++; else skipped++;
        }
      });
      res.json({ ok: true, copied, skipped });
    });
    r.get('/plan/:date/:meal', (req, res) => {
      const key = mealKey(req.params.meal);
      if (!isDate(req.params.date) || !key) throw bad('Hueco no válido');
      const s = getSlot(db, req.params.date, key);
      if (!s) throw notFound('No hay nada planificado');
      res.json(s);
    });
    r.put('/plan/:date/:meal', (req, res) => res.json(setSlot(db, req.params.date, req.params.meal, req.body || {})));
    r.delete('/plan/:date/:meal', (req, res) => {
      const key = mealKey(req.params.meal);
      if (!isDate(req.params.date) || !key) throw bad('Hueco no válido');
      db.prepare('DELETE FROM meal_plan WHERE date = ? AND meal = ?').run(req.params.date, key);
      res.json({ ok: true });
    });
  },

  quick: {
    meal: {
      description: 'Dice qué hay para comer y cenar hoy (o mañana, o la fecha indicada) para que Siri lo lea.',
      params: { date: '(opcional) YYYY-MM-DD', text: '(opcional) "mañana", "el viernes", "mañana cena"…', meal: '(opcional) desayuno, comida, merienda o cena' },
      handler({ db }, p) {
        let date = p.date && isDate(String(p.date).slice(0, 10)) ? String(p.date).slice(0, 10) : null;
        let meal = p.meal ? mealKey(p.meal) : null;
        if (p.meal && !meal) throw bad(`Tipo de comida no válido (${MEALS.join(', ')})`);
        if (p.text) {
          const ex = extractMeal(p.text);
          meal = meal || ex.meal;
          date = date || parseSpanishDate(ex.rest).date;
        }
        return dayMessage(db, date || today(), meal);
      },
    },
    'meal-plan': {
      description: 'Planifica una comida: "mañana cena lasaña" o date + meal + text. Si el plato coincide con una receta, la enlaza.',
      params: { text: 'Plato (o frase completa con día y comida)', date: '(opcional) YYYY-MM-DD, por defecto hoy', meal: '(opcional) desayuno, comida, merienda o cena; por defecto cena', cook: '(opcional) nombre de quien cocina' },
      handler({ db }, p) {
        let date = p.date && isDate(String(p.date).slice(0, 10)) ? String(p.date).slice(0, 10) : null;
        let meal = p.meal ? mealKey(p.meal) : null;
        if (p.meal && !meal) throw bad(`Tipo de comida no válido (${MEALS.join(', ')})`);
        let dish = String(p.text ?? p.title ?? p.recipe ?? '').trim();
        if (!meal) { const ex = extractMeal(dish); meal = ex.meal; dish = ex.rest; }
        if (!date) {
          const parsed = parseSpanishDate(dish);
          if (parsed.date) { date = parsed.date; dish = parsed.title; }
        }
        dish = capitalize(dish.trim());
        if (!dish) throw bad('Dime qué plato quieres planificar');
        date = date || today();
        meal = meal || 'cena';
        const recipe = findRecipeByName(db, dish);
        const cook = p.cook ? db.prepare('SELECT id FROM users WHERE lower(name) = lower(?)').get(String(p.cook)) : null;
        const slot = setSlot(db, date, meal, { recipeId: recipe?.id ?? null, text: recipe ? '' : dish, cookId: cook?.id ?? null });
        return { message: `${capitalize(dayLabel(date))} ${FOR[meal]}: ${slot.title}.`, slot };
      },
    },
  },

  calendar: {
    label: 'Menú',
    color: '#f97316',
    defaultVisible: false,
    fetch: ({ db }, { from, to }) => planRows(db, from, to).map((p) => ({
      id: `meal-${p.id}`, title: `🍽️ ${LABEL[p.meal]}: ${p.title}`, start: p.date, end: p.date, allDay: true,
      href: `#/meals?date=${p.date}`, meal: p.meal,
    })),
  },

  summary({ db }) {
    const t = today();
    const rows = planRows(db, t, t);
    const by = Object.fromEntries(rows.map((p) => [p.meal, p.title]));
    const late = nowLocal().slice(11, 16) >= '16:00';
    const main = late ? 'cena' : 'comida';
    const other = late ? 'comida' : 'cena';
    const full = by[main] || by[other] || rows[0]?.title || '—';
    const value = full.length > 28 ? `${full.slice(0, 27).trimEnd()}…` : full;
    let subtitle;
    if (!rows.length) subtitle = 'nada planificado hoy';
    else if (by[main]) subtitle = `${FOR[main]} hoy${by[other] && !late ? ` · Cena: ${by[other]}` : ''}`;
    else if (by[other]) subtitle = `${FOR[other]} hoy`;
    else subtitle = rows.map((p) => `${LABEL[p.meal]}: ${p.title}`).join(' · ');
    return { title: 'Menú de hoy', value, subtitle, href: '#/meals', meals: by };
  },
};
