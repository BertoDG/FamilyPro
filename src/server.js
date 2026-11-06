import { openDb } from './core/db.js';
import { createApp } from './core/app.js';
import { bootstrapAdmin } from './core/bootstrap.js';

const db = await openDb();
const app = await createApp(db);
await bootstrapAdmin(db);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`FamilyPro escuchando en http://localhost:${port}`));
