import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Express } from 'express';
import { openDatabase, seedDatabase, loadMasterDataSnapshot } from '../server/db.js';
import { createApp } from '../server/app.js';
import { resolveItem } from '../engine/item-resolver.js';
import { runProcurementPipeline } from '../engine/pipeline.js';
import { invokeExpress } from './http-helper.js';

describe('Round-2 Red-Team Hardening Verification', () => {
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

  it('Round-2 Bug #2: rolled-back v5.1 is marked ROLLED_BACK and never resurrects when v5.2 activates later', async () => {
    // Create & activate v5.1 effective 2026-11-05 (lowering Spot PO limit to ₹50,000)
    const amend1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/amend',
      json: {
        instruction: 'Policy Version 5.1 effective 2026-11-05: lower Spot PO limit to ₹50,000.'
      }
    });
    assert.equal(amend1.status, 201);
    const v51Id = (amend1.body as { policy_id: number }).policy_id;
    const act1 = await invokeExpress(app, {
      method: 'POST',
      url: `/api/policy/${v51Id}/activate`,
      json: { approved_by: 'Auditor' }
    });
    assert.equal(act1.status, 200);

    // Roll back to v5.0 (policy_id = 1)
    const rb = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/1/activate',
      json: { approved_by: 'Auditor' }
    });
    assert.equal(rb.status, 200);

    // Verify v5.1 is now ROLLED_BACK
    const listAfterRb = await invokeExpress(app, { method: 'GET', url: '/api/policies' });
    const policies1 = (listAfterRb.body as { policies: Array<{ policy_id: number; status: string }> }).policies;
    assert.equal(policies1.find((p) => p.policy_id === v51Id)?.status, 'ROLLED_BACK');

    // Now create & activate v5.2 effective 2026-11-15
    const amend2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/amend',
      json: {
        instruction: 'Policy Version 5.2 effective 2026-11-15: change PO consolidation window to 48 hours.'
      }
    });
    assert.equal(amend2.status, 201);
    const v52Id = (amend2.body as { policy_id: number }).policy_id;
    const act2 = await invokeExpress(app, {
      method: 'POST',
      url: `/api/policy/${v52Id}/activate`,
      json: { approved_by: 'Auditor' }
    });
    assert.equal(act2.status, 200);

    // Evaluate a PR dated 2026-11-08 (between rolled-back v5.1's 2026-11-05 and v5.2's 2026-11-15)
    // Must resolve to v5.0 (SPOT_PO for ₹1,20,000), NOT resurrected v5.1 (RFQ)!
    const snap = loadMasterDataSnapshot(db);
    const res = runProcurementPipeline({
      ...snap,
      prLines: [
        {
          pr_no: 'PR-R2-RB-1',
          pr_line: 1,
          created_at: '2026-11-08 10:00',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 600,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-12',
          urgency: 'Normal'
        }
      ]
    });
    assert.equal(res.decisions[0].policy_version, 'v5.0');
    assert.equal(res.decisions[0].route, 'SPOT_PO');

    // Restore v5.0 active for remaining tests
    await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/1/activate',
      json: { approved_by: 'Reset' }
    });
  });

  it('Round-2 Bug #4: confirmed chat session rejects further POST /api/chat/message with HTTP 409', async () => {
    const m1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 100 nitrile gloves for CHK1 by 2026-11-25, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(m1.status, 200);
    const sid = (m1.body as { session_id: string }).session_id;

    const conf = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: sid }
    });
    assert.equal(conf.status, 201);

    // Follow-up message on the already-confirmed session must return 409
    const m2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: { session_id: sid, message: 'actually change qty to 500' }
    });
    assert.equal(m2.status, 409);
  });

  it('Round-2 Bug #5: offline combined plant+category Spot PO tightening uses exact De Morgan exclusion NOT(plant AND category)', async () => {
    const amend = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/amend',
      json: {
        instruction: 'Policy Version 5.3 effective 2026-11-01: For Chakan (CHK1) Packaging items, lower the Spot PO limit to ₹1,00,000.'
      }
    });
    assert.equal(amend.status, 201);
    const draft = (amend.body as { draft_policy: ReturnType<typeof loadMasterDataSnapshot>['policies'][number] }).draft_policy;

    const snap = loadMasterDataSnapshot(db);
    const testPolicy = { ...draft, status: 'ACTIVE' as const };
    const res = runProcurementPipeline({
      ...snap,
      policies: [testPolicy],
      prLines: [
        // 1. CHK1 + Packaging (ITM-1042, no contract) @ ~₹1,44,000 -> MUST route to RFQ (over ₹1,00,000 tightened limit)
        {
          pr_no: 'PR-DM-1',
          pr_line: 1,
          created_at: '2026-11-10 09:00',
          requester: 'A',
          department: 'Stores',
          plant: 'CHK1',
          raw_item_code: 'ITM-1042',
          description: 'Wooden pallet 1200x1000',
          quantity: 120,
          uom: 'NOS',
          estimated_unit_price: null,
          need_by_date: '2026-11-18',
          urgency: 'Normal'
        },
        // 2. PUN1 + Packaging (ITM-1042, no contract) @ ~₹1,44,000 -> MUST STAY SPOT_PO (not CHK1!)
        {
          pr_no: 'PR-DM-2',
          pr_line: 1,
          created_at: '2026-11-10 09:05',
          requester: 'B',
          department: 'Stores',
          plant: 'PUN1',
          raw_item_code: 'ITM-1042',
          description: 'Wooden pallet 1200x1000',
          quantity: 120,
          uom: 'NOS',
          estimated_unit_price: null,
          need_by_date: '2026-11-18',
          urgency: 'Normal'
        },
        // 3. CHK1 + Hydraulics @ ₹1,20,000 -> MUST STAY SPOT_PO (not Packaging!)
        {
          pr_no: 'PR-DM-3',
          pr_line: 1,
          created_at: '2026-11-10 09:10',
          requester: 'C',
          department: 'Maint',
          plant: 'CHK1',
          raw_item_code: 'ITM-1038',
          description: 'Hydraulic oil HLP 68',
          quantity: 600,
          uom: 'LTR',
          estimated_unit_price: null,
          need_by_date: '2026-11-18',
          urgency: 'Normal'
        }
      ]
    });

    const byPr = new Map(res.decisions.map((d) => [d.pr_no, d]));
    assert.equal(byPr.get('PR-DM-1')?.route, 'RFQ');
    assert.equal(byPr.get('PR-DM-2')?.route, 'SPOT_PO');
    assert.equal(byPr.get('PR-DM-3')?.route, 'SPOT_PO');
  });

  it('Round-2 Bug #6: UNIT_SUFFIX_RE does not strip trailing "a" off "a4" into bare "4"', () => {
    const snap = loadMasterDataSnapshot(db);
    const m1 = resolveItem(null, 'grinding wheel a4 inch', snap.items);
    assert.equal(m1.resolved_item_code, 'NEW');

    const m2 = resolveItem(null, 'a4 copper cable 4 core', snap.items);
    assert.equal(m2.resolved_item_code, 'NEW');

    // Genuine A4 paper must still resolve cleanly
    const m3 = resolveItem(null, 'a4 paper 75gsm', snap.items);
    assert.equal(m3.resolved_item_code, 'ITM-1058');
  });

  it('Round-2 Bug #7: two separate live Chat PRs to same supplier & plant within 24h share consolidated po_id', async () => {
    // ITM-1001 and ITM-1002 are both on RC-2026-001 (S001) -> both CONTRACT_PO at PUN1 within 24h
    const c1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 50 ITM-1001 for PUN1 by 2026-11-25, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(c1.status, 200);
    const conf1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: (c1.body as { session_id: string }).session_id }
    });
    assert.equal(conf1.status, 201);
    const po1 = (conf1.body as { decision: { po_id: string; supplier_id: string } }).decision;
    assert.equal(po1.supplier_id, 'S001');
    assert.ok(po1.po_id.startsWith('PO-CHAT-'));

    const c2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 30 ITM-1002 for PUN1 by 2026-11-26, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(c2.status, 200);
    const conf2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: (c2.body as { session_id: string }).session_id }
    });
    assert.equal(conf2.status, 201);
    const po2 = (conf2.body as { decision: { po_id: string; supplier_id: string } }).decision;
    assert.equal(po2.supplier_id, 'S001');
    assert.equal(po2.po_id, po1.po_id, 'Live chat POs for same supplier+plant within 24h must share po_id');
  });

  it('Round-2 Bug #8: POST /api/contracts rejects duplicate item_code lines with HTTP 400 cleanly', async () => {
    const res = await invokeExpress(app, {
      method: 'POST',
      url: '/api/contracts',
      json: {
        contract_id: 'RC-2026-DUP',
        supplier_id: 'S001',
        start_date: '2026-11-15',
        end_date: '2027-11-14',
        value_cap: 500000,
        lines: [
          { item_code: 'ITM-1001', description: 'MS Sheet 2mm', uom: 'KG', rate: 60 },
          { item_code: 'ITM-1001', description: 'MS Sheet 2mm dup', uom: 'KG', rate: 62 }
        ]
      }
    });
    assert.equal(res.status, 400);
    const body = res.body as { error: string };
    assert.match(body.error, /duplicate item_code/i);

    // Ensure transaction did not insert partial header row
    const check = db
      .prepare('SELECT contract_id FROM contracts WHERE contract_id = ?')
      .get('RC-2026-DUP');
    assert.equal(check, undefined);
  });

  it('Round-2 Bug #9: offline chat surfaces BOTH negative qty & invalid plant errors and parses bare leading qty', async () => {
    const m1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need -50 nitrile gloves for PUN2 by Nov 28',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(m1.status, 200);
    const b1 = m1.body as { reply: string; slots: { quantity: number | null; plant: string | null } };
    assert.equal(b1.slots.quantity, null);
    assert.equal(b1.slots.plant, null);
    assert.match(b1.reply, /PUN2/i, 'Should mention invalid plant PUN2');
    assert.match(b1.reply, /positive|greater than 0/i, 'Should ALSO mention non-positive quantity');

    // Follow-up with bare leading quantity + plant + urgency
    const sid = (m1.body as { session_id: string }).session_id;
    const m2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        session_id: sid,
        message: '200 for Chakan, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(m2.status, 200);
    const b2 = m2.body as {
      ready_to_confirm: boolean;
      slots: { quantity: number | null; plant: string | null; urgency: string | null };
    };
    assert.equal(b2.slots.quantity, 200);
    assert.equal(b2.slots.plant, 'CHK1');
    assert.equal(b2.slots.urgency, 'Normal');
    assert.equal(b2.ready_to_confirm, true);
  });

  it('Round-2 Bug #10: /api/health reports groq_configured=false for placeholder GROQ_API_KEY', async () => {
    process.env.GROQ_API_KEY = 'your_groq_api_key_here';
    try {
      const h = await invokeExpress(app, { method: 'GET', url: '/api/health' });
      assert.equal(h.status, 200);
      const body = h.body as { groq_configured: boolean; active_policy_version: string };
      assert.equal(body.groq_configured, false);
      assert.equal(body.active_policy_version, 'v5.0');
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  });
});
