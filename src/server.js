import { openDb } from './core/db.js';
import { createApp } from './core/app.js';
import { bootstrapAdmin } from './core/bootstrap.js';

process.env.TZ ||= 'Europe/Madrid';
const db = openDb();
const app = createApp(db);
bootstrapAdmin(db);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`FamilyPro escuchando en http://localhost:${port}`));
