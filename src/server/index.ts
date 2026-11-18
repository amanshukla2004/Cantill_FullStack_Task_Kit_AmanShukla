import 'dotenv/config';
import { openDatabase, seedDatabase } from './db.js';
import { createApp } from './app.js';

async function bootstrap() {
  const port = Number(process.env.PORT || 3000);
  const db = openDatabase();
  const counts = await seedDatabase(db);
  console.log('[DB] Seeded master data:', counts);

  const app = createApp(db);
  const server = app.listen(port, () => {
    console.log(`[Server] Corvo PR-to-PO API running on http://localhost:${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
