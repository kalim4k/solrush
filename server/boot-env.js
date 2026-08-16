// Loads .env, and exists purely so that it can be the FIRST import of the
// entry point.
//
// `import` declarations are hoisted: every module in the graph is evaluated
// before any top-level statement of the importing file runs. So writing
//
//     import { loadEnv } from './env.js';
//     loadEnv();
//     import { pool } from './db.js';     // reads process.env at module scope
//
// loads db.js BEFORE loadEnv() has run, and the server dies reporting that
// DATABASE_URL is not set while .env sits there containing it.
//
// Module bodies do run in the order their imports are declared, so making this
// the first import is enough — and it is the one thing here that must not be
// reordered by a tidy-up of the import block.
import { loadEnv } from './env.js';

loadEnv();
