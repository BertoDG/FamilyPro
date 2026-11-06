# 🏠 FamilyPro

Web para gestionar los temas de casa: **calendario familiar**, **lista de la compra**, **gastos**, **tareas del hogar** y **menú semanal**, con acceso por **token personal** y una **API de acciones rápidas** pensada para Atajos de iPhone, Siri y la automatización de Wallet.

Está construida por módulos: cada "app" (compra, gastos, calendario…) es un módulo independiente que se enchufa al núcleo, y el **calendario principal** junta lo que publique cada módulo, con filtros para ver todo o solo lo que elijas.

- **Backend:** Node.js 22 + Express 5 + **Postgres**: [Supabase](https://supabase.com) en producción y [PGlite](https://pglite.dev) (Postgres embebido, sin instalar nada) en local y en los tests.
- **Frontend:** SPA en JavaScript sin paso de compilación. Funciona bien en móvil y se puede añadir a la pantalla de inicio (PWA).
- **Despliegue:** [Vercel](https://vercel.com) (la API como función serverless y `public/` como estáticos) o Docker.
- **Tres dependencias:** `express`, `postgres` (cliente para Supabase) y `@electric-sql/pglite`.

## Funcionalidades

| Módulo | Qué hace |
|---|---|
| 🏠 **Inicio** | Resumen (eventos de hoy, productos pendientes, gasto del mes) y **calendario principal** con todas las fuentes. Los filtros por fuente y subcalendario se guardan en tu perfil. |
| 📅 **Calendario** | Vistas de mes, semana y agenda. Eventos de día completo o con hora, repeticiones (diaria, semanal, mensual o anual, con intervalo y fecha de fin), borrar solo una repetición o toda la serie, participantes, lugar y subcalendarios con color (Familia, Colegio, Médicos…). **Feed ICS** para suscribirse desde el Calendario del iPhone. |
| 🛒 **Compra** | Varias listas (Supermercado, Farmacia…). Puedes añadir varias cosas de golpe ("leche, 2 huevos y pan"), detecta cantidades, no duplica lo que ya está pendiente, autocompleta con lo comprado antes, separa lo que ya está en el carro y se refresca sola cada 15 s. |
| 💶 **Gastos** | Categorías con icono, color, presupuesto mensual y **palabras clave**: el comercio de Wallet se clasifica solo y la app aprende de tus correcciones. Resumen mensual por categoría y por persona (lo que ha pagado y lo que le toca), histórico de 6 meses, búsqueda y exportación a CSV. **Reparto entre miembros:** cada gasto es *compartido* (por defecto, según la proporción de la casa: a partes iguales o con pesos, p.ej. 60/40) o *personal*, y admite un reparto a medida por importes o pesos. Tarjeta **Balance** con lo que ha pagado cada uno, lo que le corresponde, el saldo neto y la lista mínima de pagos ("Luis debe 12,30 € a Ana") con botón **Saldar**, que registra el pago entre miembros. |
| ✅ **Tareas** | Tareas del hogar con fecha límite (y hora opcional), prioridad, responsable y notas. Lista agrupada en Atrasadas, Hoy, Próximas, Sin fecha y Hechas recientes, filtro *Mías / Todas* y alta rápida con texto libre ("mañana sacar la basura para Luis"). **Tareas recurrentes** (diaria, semanal o mensual con intervalo) con **rotación** de responsables: al completarla, la fecha salta a la siguiente repetición y le toca al siguiente. Aparecen en el calendario principal y en el feed ICS. |
| 🍽️ **Menú** | Planificación semanal (desayuno, comida, merienda y cena; por defecto se ven comida y cena) con navegación por semanas, y en el móvil una lista por días. Cada hueco lleva una receta o texto libre, notas y quién cocina. **Recetario** con raciones, enlace, etiquetas, preparación e ingredientes (una línea por ingrediente: "2 cebollas"). Un botón pasa los ingredientes de la semana a la lista de la compra sin duplicar lo pendiente, y otro copia la semana anterior en los huecos vacíos. Fuente "Menú" opcional en el calendario principal. |
| ⚙️ **Ajustes** | Perfil, tokens (crear y revocar uno por dispositivo), miembros de la casa (solo administradores), URL de suscripción al calendario y guía de atajos con ejemplos `curl` listos para copiar. |

## Puesta en marcha

### En local (desarrollo)

```bash
npm install
npm start           # http://localhost:3000
```

Sin configurar nada usa una base de datos Postgres embebida (PGlite) guardada en `data/pglite`. La primera vez que arranca se crea el usuario administrador (`ADMIN_NAME`, por defecto `admin`) y **su token sale por consola una sola vez**. Con ese token entras en la web y desde **Ajustes → Miembros** creas al resto de la familia, cada uno con su token.

Si creas un fichero `.env` (copia [.env.example](.env.example)) con `DATABASE_URL`, la app local trabaja directamente contra Supabase.

### En internet: Vercel + Supabase

**1. Base de datos en Supabase**

1. Crea un proyecto en [supabase.com](https://supabase.com) (región *West EU* para que vaya rápido desde España) y guarda la contraseña de la base de datos.
2. En **Connect** (arriba) → **Connection string** → **Transaction pooler** copia la URL (puerto **6543**) y sustituye `[YOUR-PASSWORD]` por la contraseña.
3. Crea las tablas y el administrador desde tu ordenador:
   ```bash
   # en .env:  DATABASE_URL=postgresql://postgres.xxxx:CONTRASEÑA@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
   npm run cli -- init        # muestra el token del administrador UNA sola vez
   ```

**2. App en Vercel**

1. En [vercel.com](https://vercel.com) → **Add New → Project** → importa el repo de GitHub. No hay que tocar nada de la configuración de build: la lee de [vercel.json](vercel.json).
2. En **Environment Variables** añade `DATABASE_URL` (la misma URL del pooler) y `APP_TZ=Europe/Madrid`.
3. **Deploy**. Cada merge a `main` se publica solo y cada PR tiene su propia URL de previsualización.

> Las previsualizaciones de los PR usan la misma `DATABASE_URL` salvo que definas otra para el entorno *Preview* en Vercel. Si quieres probar sin tocar los datos reales, crea un segundo proyecto de Supabase para *Preview*.

### Con Docker

```bash
docker compose up -d --build
docker compose logs familypro   # aquí aparece el token del administrador la primera vez
```

Variables de entorno:

| Variable | Por defecto | |
|---|---|---|
| `DATABASE_URL` | — | Conexión Postgres (Supabase: usa el *Transaction pooler*, puerto 6543). También vale `POSTGRES_URL`. |
| `PGLITE_DIR` | `data/pglite` | Carpeta de la base de datos embebida, si no hay `DATABASE_URL` |
| `APP_TZ` | `Europe/Madrid` | Zona horaria de la casa (para "hoy", Siri y el ICS). En Vercel no se puede usar `TZ`. |
| `ADMIN_NAME` | `admin` | Nombre del primer usuario |
| `PORT` | `3000` | Puerto HTTP (local y Docker) |

> **Importante:** el token viaja en cada petición, así que fuera de casa usa siempre **HTTPS** (Vercel ya lo pone).

### CLI de administración

Trabaja contra la misma base de datos que la app (Supabase si hay `DATABASE_URL` en `.env`).

```bash
npm run cli -- init [nombre]          # crea tablas y, si no hay usuarios, el administrador
npm run cli -- users                  # lista usuarios
npm run cli -- add-user Lucia         # crea usuario y muestra su token
npm run cli -- add-user Pedro --admin
npm run cli -- token Ana iPhone       # nuevo token para Ana
npm run cli -- tokens Ana             # lista sus tokens
npm run cli -- revoke 3               # revoca el token con id 3
```

Con Docker: `docker compose exec familypro node scripts/cli.js users`.

## Autenticación

Cada usuario tiene uno o varios tokens (`fp_…`). En la base de datos solo se guarda su hash SHA-256, así que si pierdes uno, revócalo y crea otro. El token se puede enviar de tres formas:

1. `Authorization: Bearer fp_…` (recomendado)
2. Cabecera `X-API-Token: fp_…`
3. Parámetro `?token=fp_…` (útil para la suscripción ICS o atajos muy simples)

Lo recomendable es crear un token distinto para cada dispositivo o atajo, para poder revocarlos por separado.

## ⚡ Acciones rápidas (Atajos, Siri y Wallet)

Todas están en `/api/quick/<acción>`. Aceptan **GET o POST** (JSON, formulario o texto plano) y responden `{"ok": true, "message": "…", …}`. Si añades **`?format=text`** devuelven solo la frase, lista para la acción *Leer texto* de Siri.

| Acción | Parámetros | Ejemplo de respuesta |
|---|---|---|
| `POST /api/quick/shopping` | `text` ("leche, 2 huevos y pan"), `list` (opcional) | *Añadido a Supermercado: Leche, 2 Huevos y Pan.* |
| `GET /api/quick/shopping-list` | `list` (opcional) | *En Supermercado hay 3: Leche, 2 Huevos y Pan.* |
| `POST /api/quick/expense` | `amount`, `merchant`, `description`, `category`, `card`, `date`, `paidBy`, `source`, **o** `text` ("12,50 farmacia"); `personal=true` (o `shared=false`) para un gasto que no se reparte | *Gasto de 12,50 € en Farmacia (Salud).* |
| `GET /api/quick/balance` | `from`, `to` (opcionales) | *Luis debe 12,30 € a Ana.* / *Estáis en paz: nadie debe nada.* |
| `POST /api/quick/event` | `text` ("mañana a las 17:30 dentista"), **o** `title` + `date` + `time` + `duration`; `calendar` (opcional) | *Evento "Dentista" creado para el sábado, 7 de noviembre a las 17:30.* |
| `GET /api/quick/agenda` | `date` (opcional) | *Tienes 2: 09:00 ITV; 18:00 Natación.* |
| `POST /api/quick/task` | `text` ("mañana a las 18:00 sacar la basura", admite "… para Luis" al final), `assignee` (nombre, opcional), `date`, `time`, `priority` (opcionales) | *Tarea "Sacar la basura" añadida para el sábado, 7 de noviembre a las 18:00 (Luis).* |
| `GET /api/quick/tasks-list` | `all=true` (las de todos) o `assignee` (nombre); por defecto, las tuyas | *Tienes 2 tareas pendientes: Pagar el seguro (atrasada, 3 nov) y Fregar los platos (hoy).* |
| `GET /api/quick/meal` | `date` o `text` ("mañana", "el viernes", "mañana cena"), `meal` (opcional) | *Hoy para comer hay Lentejas (cocina Ana) y para cenar Lasaña.* |
| `POST /api/quick/meal-plan` | `text` ("mañana cena lasaña"), **o** `date` + `meal` (desayuno/comida/merienda/cena, por defecto cena) + `text`; `cook` (opcional) | *Mañana para cenar: Lasaña.* |

Si el plato de `meal-plan` coincide con el nombre de una receta, se enlaza (así sus ingredientes pueden pasar a la compra).

Los importes admiten `12,50 €`, `€12.50`, `1.234,56`… El texto libre de eventos entiende *hoy, mañana, pasado mañana, el viernes, 12/11, 15 de diciembre, a las 5, a las 17:30, a las 9 y media…*

### Atajo "Añade a la compra" (Siri)

1. Atajos → **+** → llámalo **"Añade a la compra"** (es la frase que dirás a Siri).
2. Acción **Dictar texto**.
3. Acción **Obtener contenido de URL**:
   - URL: `https://tu-dominio/api/quick/shopping?format=text`
   - Método: `POST`
   - Cabeceras: `Authorization` = `Bearer fp_TU_TOKEN`
   - Cuerpo: JSON → `text` = *Texto dictado*
4. Acción **Leer texto** (o *Mostrar resultado*) con el *Contenido de URL*.

### Automatización de Wallet (gasto automático al pagar)

1. Atajos → **Automatización** → **+** → **Transacción**. Elige las tarjetas y marca **Ejecutar inmediatamente**.
2. Acción **Obtener contenido de URL**:
   - URL: `https://tu-dominio/api/quick/expense`
   - Método: `POST`, cabecera `Authorization` = `Bearer fp_TU_TOKEN`
   - Cuerpo JSON: `amount` = *Importe*, `merchant` = *Comercio*, `card` = *Tarjeta*, `source` = `wallet`
3. (Opcional) **Mostrar notificación** con el campo `message` del resultado.

La categoría se elige sola: primero mira si ese comercio ya tiene categoría en un gasto anterior (así aprende de tus correcciones) y, si no, busca las palabras clave de cada categoría.

### Atajo "Quién debe a quién" (Siri)

Atajo llamado **"Quién debe a quién"** con **Obtener contenido de URL** `GET https://tu-dominio/api/quick/balance?format=text` (cabecera `Authorization`) y **Leer texto**.

### Cómo se reparte un gasto

- **Compartido sin reparto propio:** según la proporción por defecto de la casa (*Gastos → Reparto*): a partes iguales entre todos los miembros o por pesos (60/40, o 0 para quien no participa). Se aplica al calcular, así que cambiar la proporción recalcula esos gastos.
- **Reparto personalizado:** importes exactos por persona (deben sumar el total) o pesos/porcentajes.
- **Personal:** solo para quien lo paga; no entra en el balance.
- Saldo neto = pagado − lo que le toca + pagos enviados − pagos recibidos. Todo en céntimos enteros; los céntimos sobrantes se asignan por mayor resto y, a igualdad, al miembro con id más bajo (100 € entre tres = 33,34 + 33,33 + 33,33).

### Calendario en la app Calendario del iPhone

En **Ajustes → Calendario en el iPhone → Generar URL de suscripción** sale una URL `webcal://…/api/calendar.ics?token=…`. Añádela en *Ajustes de iOS → Calendario → Cuentas → Añadir cuenta → Otra → Añadir calendario suscrito*. Las repeticiones se exportan como `RRULE`.

## API REST (resumen)

Todas las rutas de `/api` necesitan token.

```
GET    /api/me                     PATCH /api/me {name,color,settings}
GET    /api/users                  POST  /api/users (admin)     DELETE /api/users/:id (admin)
GET    /api/tokens                 POST  /api/tokens {name}     DELETE /api/tokens/:id
GET    /api/modules                módulos activos, fuentes de calendario y acciones rápidas
GET    /api/calendar?from&to&sources=events,expenses   calendario principal agregado
GET    /api/calendar.ics?sources=…                       feed iCalendar
GET    /api/dashboard              resúmenes de cada módulo
GET    /api/quick                  lista de acciones rápidas disponibles

/api/events        GET ?from&to · POST · GET/PUT/DELETE /:id · POST /:id/exclude {date}
/api/events/calendars   GET · POST · PATCH/DELETE /:id
/api/shopping/lists     GET · POST · PATCH/DELETE /:id · GET/POST /:id/items · POST /:id/clear-checked
/api/shopping/items/:id PATCH {checked,name,quantity,notes,listId} · DELETE
/api/shopping/suggestions
/api/expenses      GET ?month&q&category&paidBy · POST · GET/PATCH/DELETE /:id
                   (POST/PATCH aceptan shared|personal y splits [{userId, amount}] o [{userId, weight|percent}]; splits:null quita el reparto propio)
/api/expenses/balances?from&to     saldos por miembro y deudas simplificadas
/api/expenses/settlements          GET ?from&to · POST {from,to,amount,date,notes} · GET/PATCH/DELETE /:id
/api/expenses/split-settings       GET · PUT {mode: equal|weights, weights: {userId: peso}}
/api/expenses/summary?month=YYYY-MM · /api/expenses/export.csv
/api/expenses/categories   GET · POST · PATCH/DELETE /:id
/api/tasks         GET ?status=pending|done|all&mine=1&assignee=<id|none>&doneSince=YYYY-MM-DD · POST
/api/tasks/:id     GET · PUT/PATCH {title,notes,dueDate,dueTime,priority,assigneeId,recurrence,recurrenceInterval,rotation,done} · DELETE
/api/tasks/:id/complete · /:id/uncomplete (POST) · /:id/history (GET)
/api/meals/recipes    GET ?q · POST {name,notes,servings,url,tags,ingredients} · GET/PUT/DELETE /:id
/api/meals/plan       GET ?from&to · GET/PUT/DELETE /:date/:meal {recipeId|text,notes,cookId}
/api/meals/plan/shopping   POST {from,to,listId?}  ingredientes de las recetas planificadas → lista de la compra
/api/meals/plan/copy       POST {from,to,overwrite?}  copia 7 días desde from a los 7 días desde to
```

**Tareas recurrentes:** una tarea recurrente es una sola fila que nunca queda "hecha". Al completarla se guarda el registro en el historial y su fecha límite avanza al siguiente múltiplo del intervalo posterior a hoy (si la semanal del lunes se completa el martes, la siguiente es el lunes siguiente; las mensuales del día 31 pasan al último día del mes). Si tiene rotación, el responsable pasa al siguiente de la lista. `uncomplete` deshace la última vez (restaura fecha y responsable). En el calendario solo aparece la próxima fecha pendiente.

## 🧩 Cómo añadir un módulo nuevo

Un módulo de backend es un objeto con este contrato (todas las claves son opcionales menos `id`):

```js
// src/modules/tareas/index.js
export default {
  id: 'tareas',                 // se monta en /api/tareas
  name: 'Tareas', icon: '✅',
  migrations: [                 // SQL de Postgres o funciones async (tx) => {}; solo se añaden al final, nunca se reordenan
    `CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL, due TEXT, done INTEGER NOT NULL DEFAULT 0)`,
  ],
  routes(router, { db }) {      // rutas autenticadas; req.user es el usuario del token
    router.get('/', async (req, res) => res.json(await db.all('SELECT * FROM tasks WHERE done = ?', 0)));
  },
  quick: {                      // aparecen en /api/quick/<nombre>
    task: {
      description: 'Añade una tarea',
      params: { text: 'Título' },
      handler: async ({ db }, params, user) => { /* … */ return { message: 'Tarea añadida' }; },
    },
  },
  calendar: {                   // fuente para el calendario principal (todo puede ser async)
    label: 'Tareas', color: '#14b8a6', defaultVisible: true,
    fetch: async ({ db }, { from, to, user }) => [/* { id, title, start, end, allDay, color, href, group? } */],
    ics: async ({ db }) => [/* opcional: elementos para el feed ICS */],
  },
  summary: async ({ db }, user) => ({ title: 'Tareas', value: '3', subtitle: 'pendientes', href: '#/tareas' }),
};
```

**Acceso a datos** (`src/core/db.js`): todo es asíncrono y los parámetros van con `?`.

```js
await db.all(sql, ...params)      // filas
await db.get(sql, ...params)      // primera fila o undefined
await db.run(sql, ...params)      // { changes }
await db.insert(sql, ...params)   // id de la fila nueva
await db.transaction(async (tx) => { /* usa tx, no db, dentro */ })
```

Para las fechas de creación usa `NOW` (texto UTC `YYYY-MM-DD HH:MM:SS`), p.ej. `` `created_at TEXT NOT NULL DEFAULT (${NOW})` ``. Las columnas de ids son `SERIAL` y los booleanos se guardan como `INTEGER` 0/1.

1. Regístralo en `src/modules/index.js`.
2. Crea su página en `public/js/modules/tareas.js` (`{ id, title, icon, module: 'tareas', render(el, ctx) }`) y añádela a `public/js/modules/index.js`.

Con eso el núcleo aplica sus migraciones, monta sus rutas y acciones rápidas, y el calendario principal y el panel de inicio lo incluyen sin tocar nada más.

## Desarrollo

```bash
npm run dev    # recarga automática
npm test       # tests de la API (node:test) sobre PGlite en memoria: no hace falta Supabase
```

```
api/index.js   entrada de Vercel (función serverless para /api/*)
src/
  core/        app (montaje de módulos), auth (tokens), db (Postgres/PGlite y migraciones), bootstrap
  lib/         parseo de importes y texto, fechas en español, repeticiones, ICS
  modules/     events · shopping · expenses · tasks · meals
public/
  js/          app (router), api, ui, calendar-view, event-editor
  js/modules/  una página por módulo
scripts/cli.js
test/
```
