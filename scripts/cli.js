#!/usr/bin/env node
// Utilidad de administración: npm run cli -- <comando>
import { openDb, migrate } from '../src/core/db.js';
import { coreMigrations, createUser, createToken } from '../src/core/auth.js';

const db = openDb();
migrate(db, 'core', coreMigrations);
const [cmd, ...args] = process.argv.slice(2);

const findUser = (name) => db.prepare('SELECT * FROM users WHERE lower(name) = lower(?)').get(name);

switch (cmd) {
  case 'users':
    console.table(db.prepare('SELECT id, name, is_admin, created_at FROM users').all());
    break;
  case 'add-user': {
    const [name, flag] = args;
    if (!name) { console.error('Uso: add-user <nombre> [--admin]'); process.exit(1); }
    const id = createUser(db, { name, isAdmin: flag === '--admin' });
    console.log(`Usuario ${name} creado. Token: ${createToken(db, id, 'inicial')}`);
    break;
  }
  case 'token': {
    const [name, label = 'cli'] = args;
    const u = name && findUser(name);
    if (!u) { console.error('Uso: token <usuario> [etiqueta]'); process.exit(1); }
    console.log(`Nuevo token para ${u.name}: ${createToken(db, u.id, label)}`);
    break;
  }
  case 'tokens': {
    const u = args[0] && findUser(args[0]);
    if (!u) { console.error('Uso: tokens <usuario>'); process.exit(1); }
    console.table(db.prepare('SELECT id, name, hint, last_used_at, created_at FROM tokens WHERE user_id = ?').all(u.id));
    break;
  }
  case 'revoke':
    db.prepare('DELETE FROM tokens WHERE id = ?').run(Number(args[0]));
    console.log('Token revocado');
    break;
  default:
    console.log(`Comandos:
  users                         Lista usuarios
  add-user <nombre> [--admin]   Crea usuario y muestra su token
  token <usuario> [etiqueta]    Genera un token nuevo
  tokens <usuario>              Lista tokens de un usuario
  revoke <idToken>              Revoca un token`);
}
