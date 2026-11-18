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

describe('Red-Team Regression Verification: All 17 Code Defects Fixed', () => {
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

  it('Bug #3: resolves spaced dimensions, compact units, and bounded typos accurately', () => {
    const snap = loadMasterDataSnapshot(db);
    const cases: Array<[string, string]> = [
      ['hex bolt m10 x 40', 'ITM-1009'],
      ['ms sheet 3mm 1250 x 2500', 'ITM-1002'],
      ['vci bag 600 x 900', 'ITM-1044'],
      ['wooden pallet 1200 x 1000', 'ITM-1042'],
      ['gearbox oil seal 45 x 62 x 8', 'ITM-1026'],
      ['pneumatic cylinder 50 x 100', 'ITM-1036'],
      ['ms angle 50 x 50 x 5', 'ITM-1005'],
      ['a4 paper 75gsm', 'ITM-1058'],
      ['nitrile glovs', 'ITM-1048'],
      ['ball bearning 6205', 'ITM-1021']
    ];
    for (const [q, expected] of cases) {
      const m = resolveItem(null, q, snap.items);
      assert.equal(m.resolved_item_code, expected, `Failed on "${q}"`);
    }
  });

  it('Bug #2: rolling back from v5.1 to v5.0 does not leak superseded v5.1 into execution', () => {
    const snap = loadMasterDataSnapshot(db);
    const v50: Policy = { ...snap.policies[0], status: 'ACTIVE' };
    const rolledBackV51: Policy = {
      ...v50,
      policy_id: 2,
      version: '5.1',
      effective_date: '2026-11-15',
      status: 'SUPERSEDED',
      rules: v50.rules.map((r) =>
        r.clause_number === '5.4'
          ? {
              ...r,
              conditions: {
                all: [
                  { field: 'group_value_inr', op: 'lt', value: 50000 },
                  { field: 'has_active_365d_history', op: 'eq', value: true }
                ]
              }
            }
          : r
      )
    };

    const res = runProcurementPipeline({
      ...snap,
      policies: [v50, rolledBackV51],
      prLines: [
        {
          pr_no: 'PR-RB-1',
          pr_line: 1,
          created_at: '2026-11-18 10:00',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 600,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-25',
          urgency: 'Normal'
        }
      ]
    });

    assert.equal(res.decisions[0].policy_version, 'v5.0');
    assert.equal(res.decisions[0].route, 'SPOT_PO');
  });

  it('Bug #5: mid-batch effective date does not leak 72h consolidation window or v5.2 stamp onto earlier PRs', () => {
    const snap = loadMasterDataSnapshot(db);
    const v50: Policy = { ...snap.policies[0], status: 'SUPERSEDED' };
    const v52: Policy = {
      ...v50,
      policy_id: 3,
      version: '5.2',
      effective_date: '2026-11-10',
      status: 'ACTIVE',
      po_consolidation_window_hours: 72
    };

    const res = runProcurementPipeline({
      ...snap,
      policies: [v50, v52],
      prLines: [
        {
          pr_no: 'PRE-1',
          pr_line: 1,
          created_at: '2026-11-02 10:00',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 100,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-12',
          urgency: 'Normal'
        },
        {
          pr_no: 'PRE-2',
          pr_line: 1,
          created_at: '2026-11-04 02:00', // 40h later (>24h under v5.0, <=72h under v5.2)
          requester: 'B',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 100,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-30', // >7d need-by so separate requirement
          urgency: 'Normal'
        },
        {
          pr_no: 'PRE-ANOM',
          pr_line: 1,
          created_at: '2026-11-02 11:00',
          requester: 'C',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 0,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-12',
          urgency: 'Normal'
        },
        {
          pr_no: 'POST-1',
          pr_line: 1,
          created_at: '2026-11-20 10:00',
          requester: 'D',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 100,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-12-10',
          urgency: 'Normal'
        }
      ]
    });

    const dPre1 = res.decisions.find((d) => d.pr_no === 'PRE-1')!;
    const dPre2 = res.decisions.find((d) => d.pr_no === 'PRE-2')!;
    const dAnom = res.decisions.find((d) => d.pr_no === 'PRE-ANOM')!;
    const dPost = res.decisions.find((d) => d.pr_no === 'POST-1')!;

    assert.notEqual(dPre1.po_id, dPre2.po_id);
    assert.equal(dAnom.policy_version, 'v5.0');
    assert.equal(dPost.policy_version, 'v5.2');
  });

  it('Bug #8 & #15: exact 2-decimal threshold checks & strategy-based contract ceiling depletion', () => {
    const snap = loadMasterDataSnapshot(db);
    // Synthetic item with price ₹199,999.60 (exact < 200000) and ₹500,000.40 (exact > 500000)
    const customPoHistory = [
      ...snap.poHistory,
      {
        po_number: '9999001',
        po_date: '2026-10-20',
        supplier_id: 'S024',
        item_code: 'ITM-1038',
        quantity: 1,
        uom: 'LTR',
        unit_price: 199999.6,
        plant: 'CHK1',
        delivered_on_time: true
      }
    ];
    const rLow = runProcurementPipeline({
      ...snap,
      poHistory: customPoHistory,
      prLines: [
        {
          pr_no: 'PR-BOUND-1',
          pr_line: 1,
          created_at: '2026-11-05 10:00',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 1,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-15',
          urgency: 'Normal'
        }
      ]
    });
    assert.equal(rLow.decisions[0].route, 'SPOT_PO');

    // Bug #15: custom CONTRACT_HOLDER route still depletes contract ceiling
    const customContractPolicy: Policy = {
      ...snap.policies[0],
      rules: snap.policies[0].rules.map((r) =>
        r.clause_number === '5.2' ? { ...r, route: 'PLANT_CONTRACT_PO' } : r
      )
    };
    const rContract = runProcurementPipeline({
      ...snap,
      policies: [customContractPolicy],
      prLines: [
        {
          pr_no: 'PR-C-1',
          pr_line: 1,
          created_at: '2026-11-04 12:40',
          requester: 'A',
          department: 'Stores',
          plant: 'PUN1',
          raw_item_code: 'ITM-1002',
          description: 'MS sheet 3mm 1250x2500',
          quantity: 15,
          uom: 'NOS',
          estimated_unit_price: null,
          need_by_date: '2026-11-15',
          urgency: 'Normal'
        }
      ]
    });
    assert.equal(rContract.decisions[0].route, 'PLANT_CONTRACT_PO');
    const rc11 = rContract.finalContracts.find((c) => c.contract_id === 'RC-2025-011')!;
    assert.ok(rc11.current_consumed_value > rc11.initial_consumed_value);
  });

  it('Bug #4 & #17: offline fallback tightening CHK1 Spot PO limit excludes CHK1 from Clause 5.4 & audit log avoids vv', async () => {
    const amend = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/amend',
      json: {
        instruction:
          'Policy Version v5.1 effective 2026-11-01: For Chakan (CHK1), reduce the Spot PO limit to ₹1,00,000.',
        actor: 'Procurement Head'
      }
    });
    assert.equal(amend.status, 201);
    const draftId = amend.body.policy_id;

    // Verify audit log does NOT have "vv5.1"
    const audit = await invokeExpress(app, { method: 'GET', url: '/api/audit-logs' });
    const draftLog = audit.body.logs.find((l: { action: string }) => l.action === 'DRAFT_CREATED');
    assert.equal(draftLog.entity_id, 'v5.1');

    await invokeExpress(app, {
      method: 'POST',
      url: `/api/policy/${draftId}/activate`,
      json: { approved_by: 'VP' }
    });

    const csvPath = path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv');
    const run = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      file: { field: 'file', filePath: csvPath, contentType: 'text/csv' }
    });
    assert.equal(run.status, 200);
    // PR-26-00146 (CHK1, ₹1,26,472) MUST flip from SPOT_PO to RFQ!
    const chkLine = run.body.decisions.find((d: { pr_no: string }) => d.pr_no === 'PR-26-00146');
    assert.equal(chkLine.route, 'RFQ');

    // Roll back to v5.0 for subsequent tests
    await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/1/activate',
      json: { approved_by: 'Reset' }
    });
  });

  it('Bug #6, #10, #11: Chat edits, Nov 28, PUN2, greetings, negative qty, double-confirm 409, and cleared po_id on escalation', async () => {
    // 1. Greeting "hello there"
    const hi = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { message: 'hello there' }
    });
    assert.equal(hi.body.slots.item_match_status, 'UNSET');

    // 2. Standalone negative quantity "-50"
    const neg = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { message: '-50' }
    });
    assert.equal(neg.body.slots.item_match_status, 'UNSET');
    assert.ok(neg.body.reply.includes('greater than 0'));

    // 3. Invalid plant "PUN2" does NOT pollute item match (ITM-1021)
    const pun2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { message: 'need 100 ball bearing 6205-2rs for PUN2 by 2026-11-28, normal' }
    });
    assert.equal(pun2.body.slots.resolved_item_code, 'ITM-1021');
    assert.equal(pun2.body.slots.plant, null);
    assert.ok(pun2.body.reply.includes('PUN2'));

    // 4. "Nov 28" date parses cleanly and does not pollute ITM-1035
    const nov28 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 100 hyd hose 1/2 inch 2 wire for PUN1 by Nov 28, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(nov28.body.slots.resolved_item_code, 'ITM-1035');
    assert.equal(nov28.body.slots.need_by_date, '2026-11-28');

    // 5. Multi-turn edit "actually change qty to 500"
    const editQty = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        session_id: nov28.body.session_id,
        message: 'actually change qty to 500',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(editQty.body.slots.quantity, 500);

    // 6. Confirm once -> 201; double-confirm -> 409 Conflict
    const firstConfirm = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: nov28.body.session_id, created_at: '2026-11-18 09:00' }
    });
    assert.equal(firstConfirm.status, 201);
    const secondConfirm = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: nov28.body.session_id, created_at: '2026-11-18 09:01' }
    });
    assert.equal(secondConfirm.status, 409);

    // 7. Live clubbing escalation SPOT_PO -> RFQ clears stale po_id
    const c1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { message: 'need 700 ltr ITM-1038 for Chakan by 2026-11-25 normal', reference_date: '2026-11-15' }
    });
    const p1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: c1.body.session_id, requester: 'U1', created_at: '2026-11-15 09:00' }
    });
    assert.equal(p1.body.decision.route, 'SPOT_PO');

    const c2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { message: 'need 700 ltr ITM-1038 for Chakan by 2026-11-26 normal', reference_date: '2026-11-16' }
    });
    const p2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: c2.body.session_id, requester: 'U2', created_at: '2026-11-16 09:00' }
    });
    assert.equal(p2.body.clubbed_with_existing, true);
    assert.equal(p2.body.decision.route, 'RFQ');

    const ws = await invokeExpress(app, { method: 'GET', url: '/api/requirements?all=true' });
    const clubbed = ws.body.requirements.find(
      (r: { id: number }) => r.id === p1.body.requirement_id
    );
    assert.equal(clubbed.route, 'RFQ');
    assert.equal(clubbed.po_id, '');
  });

  it('Bug #7, #9, #12, #13, #14, #16, #18: API validations, cross-batch PO isolation, PSL date isolation, and citation fix', async () => {
    // Bug #13: Malformed CSV & wrong-header CSV return 400
    const badCsv = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      json: { csv: 'foo,bar\nhello,world\n' }
    });
    assert.equal(badCsv.status, 400);
    const brokenCsv = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      json: { csv: 'pr_no,pr_line\n"unterminated,1' }
    });
    assert.equal(brokenCsv.status, 400);

    // Bug #14: Contract with end_date < start_date returns 400
    const badContract = await invokeExpress(app, {
      method: 'POST',
      url: '/api/contracts',
      json: {
        contract_id: 'RC-2026-999',
        supplier_id: 'S001',
        start_date: '2027-01-01',
        end_date: '2026-01-01',
        value_cap: 500000,
        lines: [{ item_code: 'ITM-1001', description: 'MS sheet 2mm', uom: 'NOS', rate: 6000 }]
      }
    });
    assert.equal(badContract.status, 400);

    // Bug #18: Non-PDF upload returns 400
    const csvAsPdf = path.join(resolveKitDataRoot(), 'master_data', 'plants.csv');
    const badPdf = await invokeExpress(app, {
      method: 'POST',
      url: '/api/contracts/upload-pdf',
      file: { field: 'file', filePath: csvAsPdf, contentType: 'application/pdf' }
    });
    assert.equal(badPdf.status, 400);

    // Bug #7: Cross-batch PO approvals do not collide
    const b1 = await invokeExpress(app, { method: 'POST', url: '/api/process-sample-batch' });
    const b2 = await invokeExpress(app, { method: 'POST', url: '/api/process-sample-batch' });

    // Bug #16: Duplicate citation points to DECISIONS.md 1.3
    const dup = b1.body.decisions.find((d: { pr_no: string }) => d.pr_no === 'PR-26-00175');
    assert.ok(dup.reason.includes('DECISIONS.md 1.3'));

    const r1 = (await invokeExpress(app, { method: 'GET', url: `/api/requirements?batch_id=${b1.body.batch_id}` }))
      .body.requirements.find((r: { po_id: string }) => r.po_id === 'PO-0001');
    const r2 = (await invokeExpress(app, { method: 'GET', url: `/api/requirements?batch_id=${b2.body.batch_id}` }))
      .body.requirements.find((r: { po_id: string }) => r.po_id === 'PO-0001');

    const a1 = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${r1.id}/approve`,
      json: { actor: 'Buyer' }
    });
    const a2 = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${r2.id}/approve`,
      json: { actor: 'Buyer' }
    });
    assert.notEqual(a1.body.created_order_ref, a2.body.created_order_ref);

    // Bug #12: Override RFQ -> PO without supplier returns 400
    const rfq = (await invokeExpress(app, { method: 'GET', url: `/api/requirements?batch_id=${b1.body.batch_id}` }))
      .body.requirements.find((r: { decision: string }) => r.decision === 'SOURCING_REQUEST');
    const noSuppOvr = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${rfq.id}/override`,
      json: {
        actor: 'Buyer',
        comment: 'Trying PO override without supplier',
        override_decision: 'PO',
        override_route: 'SPOT_PO'
      }
    });
    assert.equal(noSuppOvr.status, 400);

    // Bug #9: PSL respects as_of_date policy effective date (ignores future-dated policy)
    db.prepare(
      `INSERT INTO policies
       (document_code, version, title, effective_date, status, created_at, psl_lookback_days)
       VALUES ('CORVO-PROC-POL-04', '9.9', 'Future PSL Policy', '2026-11-15', 'ACTIVE', '2026-11-15T00:00:00Z', 30)`
    ).run();
    db.prepare("UPDATE policies SET status = 'SUPERSEDED' WHERE policy_id = 1").run();

    const pslRes = await invokeExpress(app, {
      method: 'GET',
      url: '/api/preferred-suppliers?as_of_date=2026-11-01&format=json&item_code=ITM-1036'
    });
    assert.equal(pslRes.status, 200);
    assert.equal(pslRes.body.items[0].preferred_suppliers.length, 3);
  });
});
