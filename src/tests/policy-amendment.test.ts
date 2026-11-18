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
import { Policy } from '../engine/types.js';

describe('Phase 1: Zero-Code Policy-as-Data Amendments (Plant Rules, Category Limits & Mid-Batch Effective Dates)', () => {
  let db: DatabaseSync;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
  });

  after(() => {
    db.close();
  });

  it('applies a new CHK1-only plant rule + higher category spot limit without any code change', () => {
    const snap = loadMasterDataSnapshot(db);
    const basePolicy = snap.policies[0];

    const amendedPolicy: Policy = {
      ...basePolicy,
      policy_id: 2,
      version: '5.1',
      effective_date: '2026-11-01',
      status: 'ACTIVE',
      rules: [
        basePolicy.rules[0],
        basePolicy.rules[1],
        basePolicy.rules[2],
        {
          clause_number: '5.4a',
          priority_order: 4,
          rule_name: 'Testing & Calibration Higher Spot Limit',
          conditions: {
            all: [
              { field: 'category', op: 'eq', value: 'Testing & Calibration' },
              { field: 'group_value_inr', op: 'lt', value: 400000 },
              { field: 'has_active_365d_history', op: 'eq', value: true }
            ]
          },
          outcome: 'PO',
          route: 'SPOT_PO',
          supplier_strategy: 'PREFERRED_RANK_1',
          supplier_suggestion_count: 0
        },
        {
          clause_number: '5.4b',
          priority_order: 5,
          rule_name: 'Chakan Tighter Spot Limit',
          conditions: {
            all: [
              { field: 'plant', op: 'eq', value: 'CHK1' },
              { field: 'group_value_inr', op: 'gte', value: 100000 },
              { field: 'group_value_inr', op: 'lt', value: 1000000 }
            ]
          },
          outcome: 'SOURCING_REQUEST',
          route: 'RFQ',
          supplier_strategy: 'SUGGEST_SUPPLIERS',
          supplier_suggestion_count: 3
        },
        { ...basePolicy.rules[3], priority_order: 6 },
        { ...basePolicy.rules[4], priority_order: 7 },
        { ...basePolicy.rules[5], priority_order: 8 }
      ]
    };

    const batchCsv = fs.readFileSync(getSamplePrBatchPath(), 'utf-8');
    const prLines = parsePrBatchCsv(batchCsv);

    const runV50 = runProcurementPipeline({ prLines, ...snap });
    const runV51 = runProcurementPipeline({
      prLines,
      ...snap,
      policies: [{ ...basePolicy, status: 'SUPERSEDED' }, amendedPolicy]
    });

    const ex9Before = runV50.decisions.find((d) => d.pr_no === 'PR-26-00089')!;
    const ex9After = runV51.decisions.find((d) => d.pr_no === 'PR-26-00089')!;
    assert.equal(ex9Before.route, 'RFQ');
    assert.equal(ex9After.route, 'SPOT_PO');
    assert.equal(ex9After.policy_version, 'v5.1');

    const ex5Before = runV50.decisions.find((d) => d.pr_no === 'PR-26-00146')!;
    const ex5After = runV51.decisions.find((d) => d.pr_no === 'PR-26-00146')!;
    assert.equal(ex5Before.route, 'SPOT_PO');
    assert.equal(ex5After.route, 'RFQ');
    assert.equal(ex5After.policy_version, 'v5.1');
  });

  it('respects mid-batch effective dates (v5.0 before effective_date, v5.2 on/after)', () => {
    const snap = loadMasterDataSnapshot(db);
    const basePolicy = snap.policies[0];
    const midBatchPolicy: Policy = {
      ...basePolicy,
      policy_id: 3,
      version: '5.2',
      effective_date: '2026-11-10',
      status: 'ACTIVE'
    };

    const batchCsv = fs.readFileSync(getSamplePrBatchPath(), 'utf-8');
    const prLines = parsePrBatchCsv(batchCsv);

    const res = runProcurementPipeline({
      prLines,
      ...snap,
      policies: [{ ...basePolicy, status: 'SUPERSEDED' }, midBatchPolicy]
    });

    assert.equal(res.decisions.find((d) => d.pr_no === 'PR-26-00019')?.policy_version, 'v5.0');
    assert.equal(res.decisions.find((d) => d.pr_no === 'PR-26-00045')?.policy_version, 'v5.2');
  });
});
