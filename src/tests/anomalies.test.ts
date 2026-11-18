import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  openDatabase,
  seedDatabase,
  loadMasterDataSnapshot,
  resolveKitDataRoot,
  getSamplePrBatchPath
} from '../server/db.js';
import { parsePrBatchCsv } from '../server/services/csv-utils.js';
import { runProcurementPipeline } from '../engine/pipeline.js';

describe('Phase 1: Data Anomalies, Near-Duplicate Guard & Idempotent Reprocessing', () => {
  let db: DatabaseSync;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
  });

  after(() => {
    db.close();
  });

  it('flags zero quantity, invalid plant, and near-duplicate PRs as NOT_PROCESSED', () => {
    const snap = loadMasterDataSnapshot(db);
    const batchCsv = fs.readFileSync(getSamplePrBatchPath(), 'utf-8');
    const prLines = parsePrBatchCsv(batchCsv);
    const res = runProcurementPipeline({
      prLines,
      ...snap
    });

    const find = (prNo: string, prLine = 1) =>
      res.decisions.find((d) => d.pr_no === prNo && d.pr_line === prLine)!;

    const zeroQty = find('PR-26-00172');
    assert.equal(zeroQty.decision, 'NOT_PROCESSED');
    assert.equal(zeroQty.route, 'NOT_PROCESSED');
    assert.equal(zeroQty.group_value_inr, 0);

    const badPlant = find('PR-26-00173');
    assert.equal(badPlant.decision, 'NOT_PROCESSED');
    assert.equal(badPlant.route, 'NOT_PROCESSED');
    assert.ok(badPlant.reason.includes('PUN2'));

    const orig = find('PR-26-00174');
    const dup = find('PR-26-00175');
    assert.notEqual(orig.decision, 'NOT_PROCESSED');
    assert.equal(dup.decision, 'NOT_PROCESSED');
    assert.equal(dup.route, 'NOT_PROCESSED');
    assert.ok(dup.reason.includes('PR-26-00174'));
  });

  it('produces 100% identical outputs across repeated batch runs (idempotent ceiling reset)', () => {
    const snap = loadMasterDataSnapshot(db);
    const batchCsv = fs.readFileSync(getSamplePrBatchPath(), 'utf-8');
    const prLines = parsePrBatchCsv(batchCsv);

    const run1 = runProcurementPipeline({ prLines, ...snap });
    const run2 = runProcurementPipeline({ prLines, ...snap });

    assert.deepEqual(run1.decisions, run2.decisions);
  });
});
