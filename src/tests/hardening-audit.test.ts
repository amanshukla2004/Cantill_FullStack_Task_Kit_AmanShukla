import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Express } from 'express';
import {
  openDatabase,
  seedDatabase,
  loadMasterDataSnapshot,
  resolveKitDataRoot
} from '../server/db.js';
import { createApp } from '../server/app.js';
import { resolveItem } from '../engine/item-resolver.js';
import { runProcurementPipeline } from '../engine/pipeline.js';
import { Policy } from '../engine/types.js';
import { invokeExpress } from './http-helper.js';

describe('Adversarial Hardening Audit: Unseen Items, Future-Dated Macro Windows, Dept/Item Rules & Live Chat Clubbing', () => {
  let db: DatabaseSync;
  let app: Express;
  const savedGroqKey = process.env.GROQ_API_KEY;

  before(async () => {
    delete process.env.GROQ_API_KEY;
    db = openDatabase(':memory:');
    await seedDatabase(db);
    app = createApp(db);
  });

  after(() => {
    if (savedGroqKey !== undefined) process.env.GROQ_API_KEY = savedGroqKey;
    db.close();
  });

  it('resolves all 17/17 unseen adversarial industrial item descriptions accurately', () => {
    const snap = loadMasterDataSnapshot(db);
    const cases: Array<[string, string]> = [
      ['brg 6205 2rs', 'ITM-1021'],
      ['6308 zz brg', 'ITM-1022'],
      ['hyd oil hlp 68', 'ITM-1038'],
      ['safety shoes', 'ITM-1046'],
      ['nitrile gloves', 'ITM-1048'],
      ['hex bolt m16x60 10.9', 'ITM-1014'],
      ['ms sheet 2mm', 'ITM-1001'],
      ['laptop i5 16gb', 'ITM-1056'],
      ['24" monitor', 'ITM-1057'],
      ['hp 88a toner', 'ITM-1059'],
      ['a4 paper', 'ITM-1058'],
      ['argon cyl 7 cum', 'ITM-1017'],
      ['cnc turning center', 'ITM-1069'],
      ['air compressor 30 hp', 'ITM-1070'],
      ['ss304 sheet 1.5mm', 'ITM-1004'],
      ['3d printer resin industrial', 'NEW'],
      ['solar panel 500w', 'NEW']
    ];

    for (const [query, expected] of cases) {
      const match = resolveItem(null, query, snap.items);
      assert.equal(match.resolved_item_code, expected, `Failed on "${query}"`);
    }
  });

  it('does not leak a future-dated policy macro window into an earlier batch', () => {
    const snap = loadMasterDataSnapshot(db);
    const base = snap.policies[0];
    const futurePolicy: Policy = {
      ...base,
      policy_id: 99,
      version: '9.0',
      effective_date: '2026-12-15',
      status: 'ACTIVE',
      clubbing_creation_window_days: 0 // Would break clubbing if prematurely applied to Nov batch!
    };

    const res = runProcurementPipeline({
      ...snap,
      policies: [{ ...base, status: 'SUPERSEDED' }, futurePolicy],
      prLines: [
        {
          pr_no: 'PR-T1',
          pr_line: 1,
          created_at: '2026-11-02 09:40',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 270,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-19',
          urgency: 'Normal'
        },
        {
          pr_no: 'PR-T2',
          pr_line: 1,
          created_at: '2026-11-05 08:40',
          requester: 'B',
          department: 'Production',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 300,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-21',
          urgency: 'Normal'
        }
      ]
    });

    // Must still club under v5.0 (14d window), ignoring future Dec 15 policy
    assert.equal(res.decisions[0].group_id, res.decisions[1].group_id);
    assert.equal(res.decisions[0].policy_version, 'v5.0');
  });

  it('supports department and item_code AST rules with zero code changes', () => {
    const snap = loadMasterDataSnapshot(db);
    const base = snap.policies[0];
    const deptPolicy: Policy = {
      ...base,
      policy_id: 100,
      version: '5.5',
      effective_date: '2026-11-01',
      status: 'ACTIVE',
      rules: [
        {
          clause_number: '5.0a',
          priority_order: 1,
          rule_name: 'Maintenance High-Value Emergency Override',
          conditions: {
            all: [
              { field: 'department', op: 'eq', value: 'Maintenance' },
              { field: 'urgency', op: 'eq', value: 'Emergency' },
              { field: 'group_value_inr', op: 'lte', value: 700000 },
              { field: 'has_active_365d_history', op: 'eq', value: true }
            ]
          },
          outcome: 'PO',
          route: 'EMERGENCY_PO',
          supplier_strategy: 'PREFERRED_RANK_1',
          supplier_suggestion_count: 0
        },
        ...base.rules.map((r, i) => ({ ...r, priority_order: i + 2 }))
      ]
    };

    const res = runProcurementPipeline({
      ...snap,
      policies: [{ ...base, status: 'SUPERSEDED' }, deptPolicy],
      prLines: [
        {
          pr_no: 'PR-MNT-1',
          pr_line: 1,
          created_at: '2026-11-10 10:00',
          requester: 'Eng',
          department: 'Maintenance',
          plant: 'PUN1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 3500, // ~₹5.8L (> standard ₹5L Emergency limit, <= ₹7L Maintenance limit)
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-12',
          urgency: 'Emergency'
        }
      ]
    });

    assert.equal(res.decisions[0].route, 'EMERGENCY_PO');
    assert.equal(res.decisions[0].policy_version, 'v5.5');
  });

  it('POST /api/process-batch accepts non-"file" multipart field names and /api/process-sample-batch works', async () => {
    const csvPath = path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv');
    const customFieldRes = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      file: { field: 'batch_csv', filePath: csvPath, contentType: 'text/csv' }
    });
    assert.equal(customFieldRes.status, 200);
    assert.equal(customFieldRes.body.summary.total_lines, 186);

    const sampleRes = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-sample-batch'
    });
    assert.equal(sampleRes.status, 200);
    assert.equal(sampleRes.body.summary.total_lines, 186);
  });

  it('clubs two separate Chat Intake PRs for the same item & plant and escalates SPOT_PO -> RFQ when combined > ₹2L', async () => {
    // Chat PR 1: 700 LTR Hydraulic oil HLP 68 at CHK1 (~₹1.16L -> SPOT_PO)
    const c1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 700 ltr ITM-1038 for Chakan by 2026-11-22 normal',
        reference_date: '2026-11-10'
      }
    });
    assert.equal(c1.body.ready_to_confirm, true);
    const p1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: {
        session_id: c1.body.session_id,
        requester: 'User A',
        created_at: '2026-11-10 09:00'
      }
    });
    assert.equal(p1.status, 201);
    assert.equal(p1.body.decision.route, 'SPOT_PO');
    assert.equal(p1.body.clubbed_with_existing, false);

    // Chat PR 2: 700 LTR Hydraulic oil HLP 68 at CHK1 raised 2 days later (~₹2.33L total -> clubs & escalates to RFQ!)
    const c2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 700 ltr ITM-1038 for Chakan by 2026-11-24 normal',
        reference_date: '2026-11-12'
      }
    });
    assert.equal(c2.body.ready_to_confirm, true);
    const p2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: {
        session_id: c2.body.session_id,
        requester: 'User B',
        created_at: '2026-11-12 10:00'
      }
    });
    assert.equal(p2.status, 201);
    assert.equal(p2.body.clubbed_with_existing, true);
    assert.equal(p2.body.group_id, p1.body.group_id);
    assert.equal(p2.body.decision.route, 'RFQ');
  });
});
