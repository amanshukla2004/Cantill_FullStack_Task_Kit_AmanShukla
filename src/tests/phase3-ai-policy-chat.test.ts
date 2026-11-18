import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Express } from 'express';
import { openDatabase, seedDatabase, resolveKitDataRoot } from '../server/db.js';
import { createApp } from '../server/app.js';
import { invokeExpress } from './http-helper.js';

describe('Phase 3: Hybrid Chat Intake & Policy-as-Data Amendment Lifecycle (Offline-Safe + Zero-Code Run 2)', () => {
  let db: DatabaseSync;
  let app: Express;
  const savedGroqKey = process.env.GROQ_API_KEY;

  before(async () => {
    // Ensure deterministic fallback tests run cleanly without external network in sandbox
    delete process.env.GROQ_API_KEY;
    db = openDatabase(':memory:');
    await seedDatabase(db);
    app = createApp(db);
  });

  after(() => {
    if (savedGroqKey !== undefined) process.env.GROQ_API_KEY = savedGroqKey;
    db.close();
  });

  it('Chat Intake Happy Path: "need 200 nitrile gloves for Chakan by next Friday" -> asks urgency -> confirms -> creates PR & evaluates policy', async () => {
    // Turn 1: requester types natural-language prompt from task brief
    const t1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 200 nitrile gloves for Chakan by next Friday',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t1.status, 200);
    assert.equal(t1.body.slots.resolved_item_code, 'ITM-1048');
    assert.equal(t1.body.slots.quantity, 200);
    assert.equal(t1.body.slots.plant, 'CHK1');
    assert.equal(t1.body.slots.need_by_date, '2026-11-27');
    assert.deepEqual(t1.body.missing_slots, ['urgency']);
    assert.equal(t1.body.ready_to_confirm, false);

    // Turn 2: requester provides missing urgency
    const t2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        session_id: t1.body.session_id,
        message: 'Normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.ready_to_confirm, true);
    assert.deepEqual(t2.body.missing_slots, []);

    // Confirm & create PR -> evaluates under Policy v5.0 (RC-2026-007 CONTRACT_PO!)
    const confirm = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: {
        session_id: t1.body.session_id,
        requester: 'R. Deshmukh',
        department: 'Safety',
        created_at: '2026-11-18 10:30'
      }
    });
    assert.equal(confirm.status, 201);
    assert.ok(confirm.body.pr_no.startsWith('PR-CHAT-'));
    assert.equal(confirm.body.decision.resolved_item_code, 'ITM-1048');
    assert.equal(confirm.body.decision.decision, 'PO');
    assert.equal(confirm.body.decision.route, 'CONTRACT_PO');
    assert.equal(confirm.body.decision.supplier_id, 'S029');

    // Appears immediately in Buyer Workspace
    const ws = await invokeExpress(app, { method: 'GET', url: '/api/requirements?all=true' });
    assert.equal(ws.status, 200);
    assert.ok(
      ws.body.requirements.some(
        (r: { group_id: string }) => r.group_id === confirm.body.group_id
      )
    );
  });

  it('Chat Intake Vague Item: "need 50 bearings for Bhosari next Monday, normal" asks disambiguation without guessing', async () => {
    const t1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 50 bearings for Bhosari next Monday, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t1.status, 200);
    assert.equal(t1.body.slots.item_match_status, 'AMBIGUOUS');
    assert.equal(t1.body.slots.resolved_item_code, null);
    assert.ok(t1.body.candidate_items.length >= 2);
    assert.equal(t1.body.ready_to_confirm, false);

    // User picks ITM-1022
    const t2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        session_id: t1.body.session_id,
        message: 'ITM-1022',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.slots.resolved_item_code, 'ITM-1022');
    assert.equal(t2.body.ready_to_confirm, true);
  });

  it('Chat Intake Unknown Item: never invents an item code, marks NEW and asks estimated unit price', async () => {
    const t1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        message: 'need 2 industrial laser printers for Bhosari by 2026-12-05, normal',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t1.status, 200);
    assert.equal(t1.body.slots.item_match_status, 'NEW_ITEM');
    assert.equal(t1.body.slots.resolved_item_code, 'NEW');
    assert.deepEqual(t1.body.missing_slots, ['estimated_unit_price']);
    assert.equal(t1.body.ready_to_confirm, false);

    // User supplies estimated price
    const t2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/message',
      json: {
        session_id: t1.body.session_id,
        message: '₹45,000',
        reference_date: '2026-11-18'
      }
    });
    assert.equal(t2.status, 200);
    assert.equal(t2.body.ready_to_confirm, true);

    const confirm = await invokeExpress(app, {
      method: 'POST',
      url: '/api/chat/confirm-pr',
      json: { session_id: t1.body.session_id, created_at: '2026-11-18 11:00' }
    });
    assert.equal(confirm.status, 201);
    assert.equal(confirm.body.decision.resolved_item_code, 'NEW');
    assert.equal(confirm.body.decision.route, 'NEW_ITEM_SOURCING');
    assert.equal(confirm.body.decision.group_value_inr, 90000);
    assert.equal(confirm.body.decision.suggested_supplier_ids, '');
  });

  it('Policy-as-Data Full Run 1 -> Amend -> Review/Edit -> Activate -> Run 2 with ZERO code changes', async () => {
    const csvPath = path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv');

    // Run 1 under baseline Policy v5.0
    const run1 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      file: { field: 'file', filePath: csvPath, contentType: 'text/csv' }
    });
    assert.equal(run1.status, 200);
    const ex9Run1 = run1.body.decisions.find(
      (d: { pr_no: string }) => d.pr_no === 'PR-26-00089'
    );
    assert.equal(ex9Run1.route, 'RFQ');
    assert.equal(ex9Run1.policy_version, 'v5.0');

    // Propose policy amendment via chat text (Testing & Calibration Spot PO limit -> ₹4,00,000, effective 2026-11-01)
    const amend = await invokeExpress(app, {
      method: 'POST',
      url: '/api/policy/amend',
      json: {
        instruction:
          'Policy Version 5.1 effective 2026-11-01: For Testing & Calibration category, increase Spot PO limit to ₹4,00,000.',
        actor: 'Head of Procurement'
      }
    });
    assert.equal(amend.status, 201);
    const draftId = amend.body.policy_id;
    assert.equal(amend.body.draft_policy.status, 'DRAFT');
    assert.equal(amend.body.draft_policy.version, '5.1');
    assert.equal(amend.body.draft_policy.effective_date, '2026-11-01');
    assert.ok(amend.body.diff.rules_added.length >= 1);
    assert.ok(amend.body.diff.plain_language_summary.length >= 1);

    // Test inline draft rule validation (bad operator -> 400)
    const badEdit = await invokeExpress(app, {
      method: 'PUT',
      url: `/api/policy/${draftId}`,
      json: {
        rules: [
          {
            clause_number: '5.1',
            priority_order: 1,
            rule_name: 'Broken',
            conditions: { field: 'plant', op: 'INVALID_OP', value: 'CHK1' },
            outcome: 'PO',
            route: 'SPOT_PO',
            supplier_strategy: 'PREFERRED_RANK_1',
            supplier_suggestion_count: 0
          }
        ]
      }
    });
    assert.equal(badEdit.status, 400);

    // Approve & Activate Policy v5.1
    const activate = await invokeExpress(app, {
      method: 'POST',
      url: `/api/policy/${draftId}/activate`,
      json: { approved_by: 'VP Procurement' }
    });
    assert.equal(activate.status, 200);
    assert.equal(activate.body.active_policy.status, 'ACTIVE');
    assert.equal(activate.body.active_policy.version, '5.1');

    // Run 2: Reprocess the exact same batch -> PR-26-00089 flips RFQ -> SPOT_PO under v5.1!
    const run2 = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      file: { field: 'file', filePath: csvPath, contentType: 'text/csv' }
    });
    assert.equal(run2.status, 200);
    const ex9Run2 = run2.body.decisions.find(
      (d: { pr_no: string }) => d.pr_no === 'PR-26-00089'
    );
    assert.equal(ex9Run2.route, 'SPOT_PO');
    assert.equal(ex9Run2.policy_version, 'v5.1');
    assert.equal(ex9Run2.supplier_id, 'S043');

    // Verify policy version history shows v5.0 SUPERSEDED and v5.1 ACTIVE
    const polList = await invokeExpress(app, { method: 'GET', url: '/api/policies' });
    assert.equal(polList.status, 200);
    assert.equal(polList.body.active_policy.version, '5.1');
    assert.equal(
      polList.body.policies.find((p: { version: string }) => p.version === '5.0')?.status,
      'SUPERSEDED'
    );
  });
});
