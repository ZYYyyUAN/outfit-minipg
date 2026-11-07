import { createServer } from 'node:http';
import { readConfig, safeError } from './config.js';
import { createApp } from './app.js';
import { createDatabase, probe } from './db.js';
import { createAccountService } from './services/account.js';

export async function start(config) {
  const database = createDatabase(config);
  try {
    const connection = await database.getConnection();
    let identity;
    try { identity = await probe(connection); } finally { connection.release(); }
    console.log(JSON.stringify({ event: 'database-connected', database: identity.db, version: identity.version }));
    const server = createServer(createApp(createAccountService(database, config)));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
    return { server, database, identity, async close() { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await database.end(); } };
  } catch (error) { await database.end(); throw error; }
}
if (import.meta.main) {
  try {
    const config = readConfig();
    const runtime = await start(config);
    console.log(JSON.stringify({ event: 'http-listening', url: config.publicBaseUrl + '/api/health' }));
    const shutdown = async () => { await runtime.close(); console.log(JSON.stringify({ event: 'closed' })); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) { console.error(JSON.stringify({ event: 'startup-failed', error: safeError(error) })); process.exitCode = 1; }
}
