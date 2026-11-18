import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'csv-parse/sync';
import { DatabaseSync } from 'node:sqlite';
import { Express } from 'express';
import { openDatabase, seedDatabase, resolveKitDataRoot } from '../server/db.js';
import { createApp } from '../server/app.js';
import { invokeExpress } from './http-helper.js';

describe('Phase 2: Backend REST API, Contracts PDF Service & Buyer Workspace Integration Tests', () => {
  let db: DatabaseSync;
  let app: Express;
  let uploadedBatchId: number;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
    app = createApp(db);
  });

  after(() => {
    db.close();
  });

  it('GET /api/health returns healthy status and master counts', async () => {
    const res = await invokeExpress(app, { method: 'GET', url: '/api/health' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.active_policy_version, 'v5.0');
    assert.equal(res.body.counts.items, 73);
    assert.equal(res.body.counts.suppliers, 48);
    assert.equal(res.body.counts.contracts, 12);
  });

  it('POST /api/process-batch uploads sample_pr_batch.csv and returns 186 decisions', async () => {
    const csvPath = path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv');
    const res = await invokeExpress(app, {
      method: 'POST',
      url: '/api/process-batch',
      file: { field: 'file', filePath: csvPath, contentType: 'text/csv' }
    });

    assert.equal(res.status, 200);
    uploadedBatchId = res.body.batch_id;
    assert.ok(uploadedBatchId >= 1);
    assert.equal(res.body.summary.total_lines, 186);
    assert.equal(res.body.summary.anomalies_count, 3);
    assert.equal(res.body.decisions.length, 186);
  });

  it('GET /api/export-decisions streams valid 13-column CSV matching Section 4 schema', async () => {
    const res = await invokeExpress(app, {
      method: 'GET',
      url: `/api/export-decisions?batch_id=${uploadedBatchId}`
    });

    assert.equal(res.status, 200);
    assert.ok((res.headers['content-type'] || '').includes('text/csv'));
    const rows = parse(res.text, { columns: true, skip_empty_lines: true }) as Record<
      string,
      string
    >[];
    assert.equal(rows.length, 186);

    assert.deepEqual(Object.keys(rows[0]), [
      'pr_no',
      'pr_line',
      'resolved_item_code',
      'group_id',
      'po_id',
      'decision',
      'route',
      'supplier_id',
      'unit_price',
      'group_value_inr',
      'suggested_supplier_ids',
      'policy_version',
      'reason'
    ]);

    const ex1 = rows.find((r) => r.pr_no === 'PR-26-00019')!;
    assert.equal(ex1.unit_price, '9168.71');
    const ex11 = rows.find((r) => r.pr_no === 'PR-26-00100')!;
    assert.equal(ex11.suggested_supplier_ids, 'S020;S017;S019;S018');
  });

  it('GET /api/preferred-suppliers exports top-3 CSV and full JSON explainability', async () => {
    const csvRes = await invokeExpress(app, {
      method: 'GET',
      url: '/api/preferred-suppliers?as_of_date=2026-11-01&format=csv'
    });
    assert.equal(csvRes.status, 200);
    assert.ok((csvRes.headers['content-type'] || '').includes('text/csv'));

    const rows = parse(csvRes.text, { columns: true, skip_empty_lines: true }) as Record<
      string,
      string
    >[];
    assert.deepEqual(Object.keys(rows[0]), [
      'item_code',
      'rank',
      'supplier_id',
      'reference_price'
    ]);

    const itm1036 = rows.filter((r) => r.item_code === 'ITM-1036');
    assert.deepEqual(
      itm1036.map((r) => r.supplier_id),
      ['S023', 'S022', 'S024']
    );

    const jsonRes = await invokeExpress(app, {
      method: 'GET',
      url: '/api/preferred-suppliers?as_of_date=2026-11-01&item_code=ITM-1048'
    });
    assert.equal(jsonRes.status, 200);
    assert.equal(jsonRes.body.items[0].preferred_suppliers[0].supplier_id, 'S029');
    assert.equal(jsonRes.body.items[0].preferred_suppliers[0].breakdown.contract_score, 25);
  });

  it('POST /api/contracts/upload-pdf extracts RC-2026-031.pdf and POST /api/contracts persists manual contracts', async () => {
    const pdfPath = path.join(resolveKitDataRoot(), 'contracts', 'pdf', 'RC-2026-031.pdf');
    const extractRes = await invokeExpress(app, {
      method: 'POST',
      url: '/api/contracts/upload-pdf',
      file: { field: 'file', filePath: pdfPath, contentType: 'application/pdf' }
    });
    assert.equal(extractRes.status, 200);

    const ext = extractRes.body.extracted;
    assert.equal(ext.contract_id, 'RC-2026-031');
    assert.equal(ext.supplier_id, 'S021');
    assert.equal(ext.start_date, '2026-11-15');
    assert.equal(ext.value_cap, 2000000);
    assert.equal(ext.lines.length, 3);

    const createRes = await invokeExpress(app, {
      method: 'POST',
      url: '/api/contracts',
      json: {
        contract_id: 'RC-2026-099',
        supplier_id: 'S027',
        start_date: '2026-11-25',
        end_date: '2027-11-24',
        value_cap: 1000000,
        source: 'MANUAL',
        actor: 'Procurement Lead',
        lines: [
          {
            item_code: 'ITM-1044',
            description: 'VCI bag 600x900',
            uom: 'NOS',
            rate: 19.5
          }
        ]
      }
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.contract_id, 'RC-2026-099');

    const listRes = await invokeExpress(app, {
      method: 'GET',
      url: '/api/contracts?as_of_date=2026-11-18'
    });
    assert.equal(listRes.status, 200);
    const saved = listRes.body.contracts.find(
      (c: { contract_id: string }) => c.contract_id === 'RC-2026-099'
    );
    assert.ok(saved);
    assert.equal(saved.validity_status, 'UPCOMING');
  });

  it('Buyer Workspace: Approve creates PO/RFQ, Override enforces comment & Active supplier, Audit logs everything', async () => {
    const listRes = await invokeExpress(app, {
      method: 'GET',
      url: `/api/requirements?batch_id=${uploadedBatchId}`
    });
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.requirements.length > 0);

    const poReq = listRes.body.requirements.find(
      (r: { decision: string }) => r.decision === 'PO'
    );
    const rfqReq = listRes.body.requirements.find(
      (r: { decision: string }) => r.decision === 'SOURCING_REQUEST'
    );
    assert.ok(poReq);
    assert.ok(rfqReq);

    // 1. Approve PO requirement
    const approveRes = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${poReq.id}/approve`,
      json: { actor: 'Priya (Senior Buyer)' }
    });
    assert.equal(approveRes.status, 200);
    assert.equal(approveRes.body.status, 'APPROVED');
    assert.ok(approveRes.body.created_order_ref.includes('PO-'));

    // 2. Override WITHOUT comment -> HTTP 400
    const badCommentRes = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${rfqReq.id}/override`,
      json: {
        actor: 'Priya',
        comment: '  ',
        override_decision: 'PO',
        override_route: 'SPOT_PO',
        override_supplier_id: 'S001'
      }
    });
    assert.equal(badCommentRes.status, 400);

    // 3. Override WITH Blocked supplier S004 -> HTTP 400 (Clause 5.7)
    const blockedRes = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${rfqReq.id}/override`,
      json: {
        actor: 'Priya',
        comment: 'Trying blocked supplier',
        override_decision: 'PO',
        override_route: 'SPOT_PO',
        override_supplier_id: 'S004'
      }
    });
    assert.equal(blockedRes.status, 400);

    // 4. Valid Override with written comment + Active supplier -> HTTP 200
    const overrideRes = await invokeExpress(app, {
      method: 'POST',
      url: `/api/requirements/${rfqReq.id}/override`,
      json: {
        actor: 'Priya (Senior Buyer)',
        comment: 'Urgent line breakdown verified by Plant Head; awarding direct spot PO.',
        override_decision: 'PO',
        override_route: 'SPOT_PO',
        override_supplier_id: 'S001'
      }
    });
    assert.equal(overrideRes.status, 200);
    assert.equal(overrideRes.body.status, 'OVERRIDDEN');
    assert.equal(overrideRes.body.original_decision, 'SOURCING_REQUEST');
    assert.equal(overrideRes.body.override_decision, 'PO');

    // 5. Verify Orders & Audit Logs recorded
    const ordersRes = await invokeExpress(app, { method: 'GET', url: '/api/orders' });
    assert.equal(ordersRes.status, 200);
    assert.ok(ordersRes.body.purchase_orders.length >= 2);

    const auditRes = await invokeExpress(app, { method: 'GET', url: '/api/audit-logs' });
    assert.equal(auditRes.status, 200);
    const overrideLog = auditRes.body.logs.find(
      (l: { action: string; entity_id: string }) =>
        l.action === 'OVERRIDDEN' && l.entity_id === rfqReq.group_id
    );
    assert.ok(overrideLog);
    assert.equal(overrideLog.actor, 'Priya (Senior Buyer)');
    assert.equal(overrideLog.details.original_decision, 'SOURCING_REQUEST');
    assert.ok(overrideLog.details.comment.includes('Plant Head'));
  });
});
