// npm run db:push — applies schema.sql to the database in DATABASE_URL.
import 'node:process';
import { loadEnv } from './env.js';
loadEnv();

const { migrate, close } = await import('./db.js');

try {
  await migrate();
  console.log('schema applied');
} catch (e) {
  console.error('migration failed:', e.message);
  process.exitCode = 1;
} finally {
  await close();
}
