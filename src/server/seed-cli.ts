import 'dotenv/config';
import { openDatabase, seedDatabase } from './db.js';

async function main() {
  const db = openDatabase();
  const firstRun = await seedDatabase(db);
  const secondRun = await seedDatabase(db);
  console.log('Seed run 1:', firstRun);
  console.log('Seed run 2 (idempotency check):', secondRun);
  db.close();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
