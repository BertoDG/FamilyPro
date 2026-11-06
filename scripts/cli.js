#!/usr/bin/env node
// Utilidad de administración: npm run cli -- <comando>
// Usa la misma base de datos que la app: DATABASE_URL (Supabase) si está definida; si no, PGlite local en data/pglite.
import { openDb, migrateAll } from '../src/core/db.js';
import { coreMigrations, createUser, createToken } from '../src/core/auth.js';
import { bootstrapAdmin } from '../src/core/bootstrap.js';
import { modules } from '../src/modules/index.js';

const db = await openDb();
await migrateAll(db, [['core', coreMigrations], ...modules.map((m) => [m.id, m.migrations])]);
const [cmd, ...args] = process.argv.slice(2);

const findUser = (name) => db.get('SELECT * FROM users WHERE lower(name) = lower(?::text)', name);

switch (cmd) {
  case 'init': {
    // Crea las tablas y, si la base de datos está vacía, el administrador inicial (muestra su token una vez).
    const token = await bootstrapAdmin(db, args[0] || process.env.ADMIN_NAME || 'admin');
    if (!token) console.log('La base de datos ya estaba inicializada (hay usuarios). Tablas al día.');
    break;
  }
  case 'users':
    console.table(await db.all('SELECT id, name, is_admin, created_at FROM users ORDER BY id'));
    break;
  case 'add-user': {
    const [name, flag] = args;
    if (!name) { console.error('Uso: add-user <nombre> [--admin]'); process.exitCode = 1; break; }
    const id = await createUser(db, { name, isAdmin: flag === '--admin' });
    console.log(`Usuario ${name} creado. Token: ${await createToken(db, id, 'inicial')}`);
    break;
  }
  case 'token': {
    const [name, label = 'cli'] = args;
    const u = name && await findUser(name);
    if (!u) { console.error('Uso: token <usuario> [etiqueta]'); process.exitCode = 1; break; }
    console.log(`Nuevo token para ${u.name}: ${await createToken(db, u.id, label)}`);
    break;
  }
  case 'tokens': {
    const u = args[0] && await findUser(args[0]);
    if (!u) { console.error('Uso: tokens <usuario>'); process.exitCode = 1; break; }
    console.table(await db.all('SELECT id, name, hint, last_used_at, created_at FROM tokens WHERE user_id = ? ORDER BY id', u.id));
    break;
  }
  case 'revoke':
    await db.run('DELETE FROM tokens WHERE id = ?', Number(args[0]));
    console.log('Token revocado');
    break;
  default:
    console.log(`Comandos:
  init [nombre]                 Crea las tablas y el administrador inicial si no hay usuarios
  users                         Lista usuarios
  add-user <nombre> [--admin]   Crea usuario y muestra su token
  token <usuario> [etiqueta]    Genera un token nuevo
  tokens <usuario>              Lista tokens de un usuario
  revoke <idToken>              Revoca un token`);
}
await db.close();
