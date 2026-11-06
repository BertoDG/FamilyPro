// Registro de módulos. Para añadir una nueva "app" al hogar crea src/modules/<id>/index.js
// siguiendo el contrato documentado en README.md y añádela aquí.
import events from './events/index.js';
import shopping from './shopping/index.js';
import expenses from './expenses/index.js';
import tasks from './tasks/index.js';

export const modules = [events, shopping, expenses, tasks];
