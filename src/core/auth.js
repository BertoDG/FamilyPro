import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'fp_';

export const coreMigrations = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     color TEXT NOT NULL DEFAULT '#4f7cff',
     is_admin INTEGER NOT NULL DEFAULT 0,
     settings TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL DEFAULT (datetime('now')));
   CREATE TABLE tokens (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     token_hash TEXT NOT NULL UNIQUE,
     hint TEXT NOT NULL,
     last_used_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')));`,
];

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Crea un token nuevo para un usuario. Devuelve el token en claro (solo se muestra una vez). */
export function createToken(db, userId, name = 'web') {
  const token = TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO tokens (user_id, name, token_hash, hint) VALUES (?, ?, ?, ?)')
    .run(userId, name, hashToken(token), token.slice(-4));
  return token;
}

export function createUser(db, { name, color, isAdmin = false }) {
  const r = db.prepare('INSERT INTO users (name, color, is_admin) VALUES (?, COALESCE(?, \'#4f7cff\'), ?)')
    .run(name, color ?? null, isAdmin ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function findUserByToken(db, token) {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = db.prepare(`SELECT u.*, t.id AS token_id FROM tokens t JOIN users u ON u.id = t.user_id
                          WHERE t.token_hash = ?`).get(hashToken(token));
  if (!row) return null;
  db.prepare("UPDATE tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.token_id);
  return publicUser(row);
}

export function publicUser(u) {
  let settings = {};
  try { settings = JSON.parse(u.settings || '{}'); } catch { /* ignore */ }
  return { id: u.id, name: u.name, color: u.color, isAdmin: !!u.is_admin, settings, tokenId: u.token_id };
}

/** Extrae el token de: Authorization: Bearer, cabecera X-API-Token o ?token= (útil para atajos y ICS). */
export function extractToken(req) {
  const h = req.get('authorization');
  if (h && /^bearer\s+/i.test(h)) return h.replace(/^bearer\s+/i, '').trim();
  return req.get('x-api-token') || req.query?.token || req.body?.token || null;
}

export function authMiddleware(db) {
  return (req, res, next) => {
    const user = findUserByToken(db, extractToken(req));
    if (!user) return res.status(401).json({ ok: false, error: 'Token no válido o ausente' });
    req.user = user;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ ok: false, error: 'Solo administradores' });
  next();
}
