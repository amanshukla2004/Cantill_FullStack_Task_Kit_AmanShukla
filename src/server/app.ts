import fs from 'node:fs';
import path from 'node:path';
import express, { Express } from 'express';
import cors from 'cors';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot } from './db.js';
import { formatPolicyVersion } from '../engine/waterfall-evaluator.js';
import { groqClient } from './services/groq-client.js';
import { createBatchRouter } from './routes/batch.js';
import { createSuppliersRouter } from './routes/suppliers.js';
import { createContractsRouter } from './routes/contracts.js';
import { createWorkspaceRouter } from './routes/workspace.js';
import { createChatRouter } from './routes/chat.js';
import { createPolicyRouter } from './routes/policy.js';

export function createApp(db: DatabaseSync): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ type: 'text/csv', limit: '10mb' }));

  // Health & Master Data Overview
  app.get('/api/health', (_req, res) => {
    const snap = loadMasterDataSnapshot(db);
    const activePolicy = snap.policies.find((p) => p.status === 'ACTIVE') || snap.policies[0];
    res.json({
      status: 'ok',
      active_policy_version: activePolicy ? formatPolicyVersion(activePolicy.version) : 'none',
      active_policy_effective_date: activePolicy?.effective_date ?? null,
      groq_configured: groqClient.isConfigured(),
      counts: {
        plants: snap.plants.size,
        items: snap.items.size,
        suppliers: snap.suppliers.size,
        contracts: snap.contracts.length,
        po_history: snap.poHistory.length
      }
    });
  });

  app.get('/api/master-data', (_req, res) => {
    const snap = loadMasterDataSnapshot(db);
    res.json({
      plants: Array.from(snap.plants.values()),
      items: Array.from(snap.items.values()),
      suppliers: Array.from(snap.suppliers.values()),
      categories: Array.from(new Set(Array.from(snap.items.values()).map((i) => i.category))).sort()
    });
  });

  // Phase 2 & Phase 3 Core Routers
  app.use('/api', createBatchRouter(db));
  app.use('/api', createSuppliersRouter(db));
  app.use('/api', createContractsRouter(db));
  app.use('/api', createWorkspaceRouter(db));
  app.use('/api', createChatRouter(db));
  app.use('/api', createPolicyRouter(db));

  // Serve built frontend bundle when present
  const publicDir = path.join(process.cwd(), 'dist', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(publicDir, 'index.html'));
    });
  }

  return app;
}
