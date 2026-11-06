// Punto de entrada en Vercel: una única función serverless que atiende todo /api/*.
// La web (public/) la sirve Vercel directamente como estáticos.
import { openDb } from '../src/core/db.js';
import { createApp } from '../src/core/app.js';

let appPromise = null;

function getApp() {
  if (!appPromise) {
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      return Promise.reject(new Error('Falta DATABASE_URL: configura la conexión a Supabase en las variables de entorno de Vercel.'));
    }
    // Se reutiliza entre peticiones mientras la instancia siga viva; si falla, se reintenta en la siguiente.
    appPromise = openDb().then((db) => createApp(db)).catch((e) => { appPromise = null; throw e; });
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: 'El servidor no ha podido arrancar. Revisa los logs de Vercel.' }));
  }
}
