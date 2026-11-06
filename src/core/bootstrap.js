import { createUser, createToken } from './auth.js';

/** Si no hay usuarios, crea el administrador inicial y muestra su token por consola (una única vez). */
export function bootstrapAdmin(db, name = process.env.ADMIN_NAME || 'admin') {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return null;
  const id = createUser(db, { name, isAdmin: true });
  const token = createToken(db, id, 'inicial');
  console.log('\n==============================================');
  console.log(` Usuario administrador creado: ${name}`);
  console.log(` Token (guárdalo, no se volverá a mostrar):`);
  console.log(`   ${token}`);
  console.log('==============================================\n');
  return token;
}
