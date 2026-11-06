import { bad, intId, notFound } from '../../core/http.js';
import { transaction, NOW } from '../../core/db.js';
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

const ingredientsOf = (db, id) => db.all('SELECT name, quantity FROM meal_ingredients WHERE recipe_id = ? ORDER BY position, id', id);
const rowToRecipe = async (db, r) => r && ({ ...r, tags: parseJSON(r.tags, []), ingredients: await ingredientsOf(db, r.id) });
const getRecipe = async (db, id) => rowToRecipe(db, await db.get('SELECT * FROM meal_recipes WHERE id = ?', id));

async function saveRecipe(db, b, id = null) {
  const cur = id ? await getRecipe(db, id) : {};
  if (id && !cur) throw notFound('Receta no encontrada');
  const name = String(b.name ?? cur.name ?? '').trim();
  if (!name) throw bad('Falta el nombre de la receta');
  const servings = b.servings === undefined ? (cur.servings ?? null) : (Number(b.servings) > 0 ? Math.round(Number(b.servings)) : null);
  const v = {
    name, notes: String(b.notes ?? cur.notes ?? ''), servings, url: String(b.url ?? cur.url ?? '').trim(),
    tags: JSON.stringify(b.tags === undefined ? (cur.tags ?? []) : normTags(b.tags)),
  };
  return transaction(db, async (tx) => {
    if (id) {
      await tx.run('UPDATE meal_recipes SET name = ?, notes = ?, servings = ?, url = ?, tags = ? WHERE id = ?', v.name, v.notes, v.servings, v.url, v.tags, id);
    } else {
      id = await tx.insert('INSERT INTO meal_recipes (name, notes, servings, url, tags) VALUES (?, ?, ?, ?, ?)', v.name, v.notes, v.servings, v.url, v.tags);
    }
    if (b.ingredients !== undefined || !cur.id) {
      await tx.run('DELETE FROM meal_ingredients WHERE recipe_id = ?', id);
      for (const [i, x] of normIngredients(b.ingredients).entries()) {
        await tx.run('INSERT INTO meal_ingredients (recipe_id, name, quantity, position) VALUES (?, ?, ?, ?)', id, x.name, x.quantity || '', i);
      }
    }
    return getRecipe(tx, id);
  });
}

const planRows = async (db, from, to) => (await db.all(`
  SELECT p.*, r.name AS recipe_name, u.name AS cook_name, u.color AS cook_color FROM meal_plan p
  LEFT JOIN meal_recipes r ON r.id = p.recipe_id LEFT JOIN users u ON u.id = p.cook_id
  WHERE p.date BETWEEN ? AND ?`, from, to))
  .map((p) => ({ ...p, title: p.recipe_name || p.text }))
  .sort((a, b) => a.date.localeCompare(b.date) || MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));

const getSlot = async (db, date, meal) => (await planRows(db, date, date)).find((p) => p.meal === meal) || null;

async function findRecipeByName(db, name) {
  const n = norm(name);
  if (!n) return null;
  return (await db.all('SELECT id, name FROM meal_recipes')).find((r) => norm(r.name) === n) || null;
}

const UPSERT = `INSERT INTO meal_plan (date, meal, recipe_id, text, notes, cook_id) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(date, meal) DO UPDATE SET recipe_id = excluded.recipe_id, text = excluded.text, notes = excluded.notes,
    cook_id = excluded.cook_id, updated_at = ${NOW}`;

async function setSlot(db, date, meal, b) {
  if (!isDate(date)) throw bad('Fecha no válida (YYYY-MM-DD)');
  const key = mealKey(meal);
  if (!key) throw bad(`Tipo de comida no válido (${MEALS.join(', ')})`);
  let recipeId = b.recipeId ?? b.recipe_id ?? null;
  recipeId = recipeId === null || recipeId === '' ? null : intId(recipeId);
  if (recipeId && !await db.get('SELECT 1 FROM meal_recipes WHERE id = ?', recipeId)) throw notFound('Receta no encontrada');
  const text = String(b.text ?? '').trim();
  if (!recipeId && !text) throw bad('Elige una receta o escribe qué hay');
  let cookId = b.cookId ?? b.cook_id ?? null;
  cookId = cookId === null || cookId === '' ? null : intId(cookId);
  await db.run(UPSERT, date, key, recipeId, text, String(b.notes ?? ''), cookId);
  return getSlot(db, date, key);
}

const hasShopping = async (db) => !!(await db.get("SELECT to_regclass('shopping_items') IS NOT NULL AS ok"))?.ok;

/** Añade a la lista de la compra los ingredientes de las recetas planificadas entre from y to. */
export async function exportIngredients(db, { from, to, listId, user }) {
  if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
  if (!await hasShopping(db)) throw bad('El módulo de compra no está activo');
  const list = listId
    ? await db.get('SELECT id, name FROM shopping_lists WHERE id = ?', intId(listId))
    : await db.get('SELECT id, name FROM shopping_lists ORDER BY position, id LIMIT 1');
  if (!list) throw notFound('Lista no encontrada');
  const recipeIds = [...new Set((await planRows(db, from, to)).filter((p) => p.recipe_id).map((p) => p.recipe_id))];
  const lines = [];
  for (const id of recipeIds) lines.push(...(await ingredientsOf(db, id)).map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name)));
  const { added, skipped } = lines.length ? await addItems(db, { listId: list.id, text: lines, user }) : { added: [], skipped: [] };
  let message = added.length ? `Añadido a ${list.name}: ${joinEs(added)}.` : '';
  if (skipped.length) message += `${message ? ' ' : ''}Ya estaba en la lista: ${joinEs(skipped)}.`;
  if (!message) message = recipeIds.length ? 'Las recetas planificadas no tienen ingredientes.' : 'No hay recetas planificadas en esas fechas.';
  return { message, list: list.name, listId: list.id, recipes: recipeIds.length, added, skipped };
}

async function dayMessage(db, date, onlyMeal) {
  const rows = (await planRows(db, date, date)).filter((p) => (onlyMeal ? p.meal === onlyMeal : true));
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
       id SERIAL PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', servings INTEGER,
       url TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (${NOW}));
     CREATE TABLE meal_ingredients (
       id SERIAL PRIMARY KEY,
       recipe_id INTEGER NOT NULL REFERENCES meal_recipes(id) ON DELETE CASCADE,
       name TEXT NOT NULL, quantity TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX idx_meal_ingredients_recipe ON meal_ingredients(recipe_id);
     CREATE TABLE meal_plan (
       id SERIAL PRIMARY KEY, date TEXT NOT NULL,
       meal TEXT NOT NULL CHECK (meal IN ('desayuno', 'comida', 'merienda', 'cena')),
       recipe_id INTEGER REFERENCES meal_recipes(id) ON DELETE SET NULL, text TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
       cook_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
       created_at TEXT NOT NULL DEFAULT (${NOW}), updated_at TEXT NOT NULL DEFAULT (${NOW}),
       UNIQUE (date, meal));`,
  ],

  routes(r, { db }) {
    // ---------- Recetas ----------
    r.get('/recipes', async (req, res) => {
      const q = norm(req.query.q);
      const rows = await Promise.all((await db.all('SELECT * FROM meal_recipes ORDER BY lower(name), id')).map((x) => rowToRecipe(db, x)));
      res.json(q ? rows.filter((x) => norm(`${x.name} ${x.tags.join(' ')}`).includes(q)) : rows);
    });
    r.post('/recipes', async (req, res) => res.status(201).json(await saveRecipe(db, req.body || {})));
    r.get('/recipes/:id', async (req, res) => {
      const x = await getRecipe(db, intId(req.params.id));
      if (!x) throw notFound('Receta no encontrada');
      res.json(x);
    });
    r.put('/recipes/:id', async (req, res) => res.json(await saveRecipe(db, req.body || {}, intId(req.params.id))));
    r.delete('/recipes/:id', async (req, res) => {
      const id = intId(req.params.id);
      const x = await getRecipe(db, id);
      if (!x) throw notFound('Receta no encontrada');
      await transaction(db, async (tx) => {
        // Lo ya planificado conserva el nombre como texto libre
        await tx.run("UPDATE meal_plan SET text = ? WHERE recipe_id = ? AND text = ''", x.name, id);
        await tx.run('DELETE FROM meal_recipes WHERE id = ?', id);
      });
      res.json({ ok: true });
    });

    // ---------- Planificación ----------
    r.get('/plan', async (req, res) => {
      const from = req.query.from || today();
      const to = req.query.to || fmtDate(addDays(toUTC(from), 6));
      if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
      if (toUTC(to) - toUTC(from) > 400 * 864e5) throw bad('Rango demasiado grande (máx. 400 días)');
      res.json(await planRows(db, from, to));
    });
    r.post('/plan/shopping', async (req, res) => {
      const b = req.body || {};
      res.json({ ok: true, ...await exportIngredients(db, { from: b.from, to: b.to || b.from, listId: b.listId, user: req.user }) });
    });
    /** Copia el plan de 7 días que empiezan en `from` a los 7 días que empiezan en `to`. */
    r.post('/plan/copy', async (req, res) => {
      const { from, to, overwrite = false } = req.body || {};
      const days = Math.min(31, Math.max(1, Number(req.body?.days) || 7));
      if (!isDate(from) || !isDate(to)) throw bad('from/to deben ser YYYY-MM-DD');
      if (from === to) throw bad('Las semanas de origen y destino son la misma');
      const offset = Math.round((toUTC(to) - toUTC(from)) / 864e5);
      const src = await planRows(db, from, fmtDate(addDays(toUTC(from), days - 1)));
      let copied = 0, skipped = 0;
      await transaction(db, async (tx) => {
        const sql = overwrite
          ? UPSERT
          : 'INSERT INTO meal_plan (date, meal, recipe_id, text, notes, cook_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, meal) DO NOTHING';
        for (const p of src) {
          const { changes } = await tx.run(sql, fmtDate(addDays(toUTC(p.date), offset)), p.meal, p.recipe_id, p.text, p.notes, p.cook_id);
          if (Number(changes)) copied++; else skipped++;
        }
      });
      res.json({ ok: true, copied, skipped });
    });
    r.get('/plan/:date/:meal', async (req, res) => {
      const key = mealKey(req.params.meal);
      if (!isDate(req.params.date) || !key) throw bad('Hueco no válido');
      const s = await getSlot(db, req.params.date, key);
      if (!s) throw notFound('No hay nada planificado');
      res.json(s);
    });
    r.put('/plan/:date/:meal', async (req, res) => res.json(await setSlot(db, req.params.date, req.params.meal, req.body || {})));
    r.delete('/plan/:date/:meal', async (req, res) => {
      const key = mealKey(req.params.meal);
      if (!isDate(req.params.date) || !key) throw bad('Hueco no válido');
      await db.run('DELETE FROM meal_plan WHERE date = ? AND meal = ?', req.params.date, key);
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
      async handler({ db }, p) {
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
        const recipe = await findRecipeByName(db, dish);
        const cook = p.cook ? await db.get('SELECT id FROM users WHERE lower(name) = lower(?::text)', String(p.cook)) : null;
        const slot = await setSlot(db, date, meal, { recipeId: recipe?.id ?? null, text: recipe ? '' : dish, cookId: cook?.id ?? null });
        return { message: `${capitalize(dayLabel(date))} ${FOR[meal]}: ${slot.title}.`, slot };
      },
    },
  },

  calendar: {
    label: 'Menú',
    color: '#f97316',
    defaultVisible: false,
    fetch: async ({ db }, { from, to }) => (await planRows(db, from, to)).map((p) => ({
      id: `meal-${p.id}`, title: `🍽️ ${LABEL[p.meal]}: ${p.title}`, start: p.date, end: p.date, allDay: true,
      href: `#/meals?date=${p.date}`, meal: p.meal,
    })),
  },

  async summary({ db }) {
    const t = today();
    const rows = await planRows(db, t, t);
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
