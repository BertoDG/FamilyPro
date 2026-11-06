import fs from 'node:fs';

/*
 * Capa de datos: Postgres con una interfaz mínima y asíncrona.
 *
 *   await db.all(sql, ...params)    → filas
 *   await db.get(sql, ...params)    → primera fila o undefined
 *   await db.run(sql, ...params)    → { changes }
 *   await db.insert(sql, ...params) → id de la fila insertada (añade RETURNING id)
 *   await db.exec(sql)              → varias sentencias sin parámetros (migraciones)
 *   await db.transaction(async (tx) => …)  → todo lo de dentro debe usar `tx`, no `db`
 *
 * Los parámetros se escriben con `?` (se traducen a $1, $2…).
 *
 * Motores:
 *   - DATABASE_URL / POSTGRES_URL = postgres://…  → servidor Postgres (Supabase en producción).
 *   - Si no hay URL → PGlite (Postgres embebido en WebAssembly) en data/pglite, o en memoria con 'memory://'.
 */

/** Marca de tiempo UTC en el mismo formato que usaba SQLite: 'YYYY-MM-DD HH:MM:SS'. */
export const NOW = "to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')";

const INT8 = 20;
const cache = new Map();
function toPg(sql) {
  let out = cache.get(sql);
  if (out !== undefined) return out;
  let n = 0, quoted = false;
  out = '';
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  cache.set(sql, out);
  return out;
}
const clean = (params) => params.map((p) => (p === undefined || Number.isNaN(p) ? null : p));

class Db {
  constructor(driver) { this.driver = driver; }
  async all(sql, ...params) { return (await this.driver.query(toPg(sql), clean(params))).rows; }
  async get(sql, ...params) { return (await this.all(sql, ...params))[0]; }
  async run(sql, ...params) { return { changes: (await this.driver.query(toPg(sql), clean(params))).changes }; }
  async insert(sql, ...params) { return Number((await this.get(`${sql} RETURNING id`, ...params)).id); }
  async exec(sql) { await this.driver.exec(sql); }
  async transaction(fn) {
    if (this.inTx) return fn(this); // transacciones anidadas: se aprovecha la de fuera
    return this.driver.begin((d) => { const tx = new Db(d); tx.inTx = true; return fn(tx); });
  }
  async close() { await this.driver.close?.(); }
}

/** Atajo para módulos: transaction(db, async (tx) => …). */
export const transaction = (db, fn) => db.transaction(fn);

// ---------- Motor PGlite (local y tests) ----------

function pgliteDriver(pg) {
  return {
    async query(text, params) {
      const r = await pg.query(text, params);
      return { rows: r.rows, changes: r.affectedRows ?? 0 };
    },
    exec: (text) => pg.exec(text),
    begin: (fn) => pg.transaction((tx) => fn(pgliteDriver(tx))),
    close: () => pg.close?.(),
  };
}

async function openPglite(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (!dir.startsWith('memory://')) fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir, { parsers: { [INT8]: Number } });
  await pg.waitReady;
  return pgliteDriver(pg);
}

// ---------- Motor Postgres (Supabase) ----------

function postgresDriver(sql) {
  return {
    async query(text, params) {
      const r = await sql.unsafe(text, params);
      return { rows: [...r], changes: r.count ?? 0 };
    },
    exec: (text) => sql.unsafe(text),
    begin: (fn) => sql.begin((tx) => fn(postgresDriver(tx))),
    close: () => sql.end?.({ timeout: 5 }),
  };
}

async function openPostgres(url) {
  const { default: postgres } = await import('postgres');
  // Los parámetros de la URL (sslmode, supa, pgbouncer…) no se pasan al servidor: algunos no los reconoce.
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  u.search = '';
  const sql = postgres(u.toString(), {
    ssl: local ? false : 'require',
    prepare: false, // necesario con el pooler de Supabase en modo transacción (puerto 6543)
    max: Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 1 : 5),
    idle_timeout: 20,
    onnotice: () => {},
    types: { int8: { to: INT8, from: [INT8], serialize: String, parse: Number } },
  });
  return postgresDriver(sql);
}

/** Abre la base de datos. Sin URL de Postgres usa PGlite (por defecto en data/pglite). */
export async function openDb(target = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PGLITE_DIR || 'data/pglite') {
  const driver = /^postgres(ql)?:\/\//.test(target) ? await openPostgres(target) : await openPglite(target);
  return new Db(driver);
}

/**
 * Aplica las migraciones pendientes de varios ámbitos: [[scope, migraciones], …].
 * Cada migración es SQL o una función async (tx) => {}. Nunca se reordenan: solo se añaden al final.
 * Todo va en una transacción con un cerrojo, por si arrancan dos instancias a la vez (serverless).
 */
export async function migrateAll(db, plan) {
  await db.transaction(async (tx) => {
    await tx.get('SELECT pg_advisory_xact_lock(7271)');
    await tx.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      scope TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (${NOW}),
      PRIMARY KEY (scope, version))`);
    for (const [scope, migrations = []] of plan) {
      const current = (await tx.get('SELECT MAX(version) AS v FROM _migrations WHERE scope = ?', scope))?.v ?? 0;
      for (const [i, m] of migrations.entries()) {
        const version = i + 1;
        if (version <= current) continue;
        if (typeof m === 'function') await m(tx); else await tx.exec(m);
        await tx.run('INSERT INTO _migrations (scope, version) VALUES (?, ?)', scope, version);
      }
    }
  });
}

export const migrate = (db, scope, migrations) => migrateAll(db, [[scope, migrations]]);
