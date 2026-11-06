// Registro de páginas del frontend. Para añadir una "app" nueva crea su fichero y añádela aquí.
// `module` (opcional) indica el módulo de backend del que depende: si no está activo, la página se oculta.
import home from './home.js';
import events from './events.js';
import shopping from './shopping.js';
import expenses from './expenses.js';
import settings from './settings.js';

export const pages = [home, events, shopping, expenses, settings];
