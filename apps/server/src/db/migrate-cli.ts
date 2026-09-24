import { loadConfig } from '../config.js';
import { createDatabase, migrate } from './index.js';

const config = loadConfig();
const database = createDatabase(config.databaseUrl, { max: 2, applicationName: 'smartproctoring-migrate' });
try {
  await migrate(database);
  console.log('Migrations applied.');
} finally {
  await database.close();
}
