import fs from 'node:fs';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  openDatabase,
  seedDatabase,
  loadMasterDataSnapshot,
  resolveKitDataRoot
} from '../server/db.js';
import { parsePrBatchCsv } from '../server/services/csv-utils.js';
import { runProcurementPipeline, PipelineRunResult } from '../engine/pipeline.js';
import { DecisionOutput } from '../engine/types.js';

describe('Phase 1: All 14/14 Worked Examples Verified on Full 186-Line Sample Batch', () => {
  let db: DatabaseSync;
  let result: PipelineRunResult;
  let byKey: Map<string, DecisionOutput>;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
    const snap = loadMasterDataSnapshot(db);
    const batchCsv = fs.readFileSync(
      path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv'),
      'utf-8'
    );
    const prLines = parsePrBatchCsv(batchCsv);
    result = runProcurementPipeline({
      prLines,
      plants: snap.plants,
      items: snap.items,
      suppliers: snap.suppliers,
      contracts: snap.contracts,
      contractLines: snap.contractLines,
      poHistory: snap.poHistory,
      policies: snap.policies
    });

    byKey = new Map<string, DecisionOutput>();
    for (const d of result.decisions) {
      byKey.set(`${d.pr_no}/${d.pr_line}`, d);
    }
  });

  after(() => {
    db.close();
  });

  it('produces exactly 186 decision rows with zero Blocked or Inactive suppliers', () => {
    const snap = loadMasterDataSnapshot(db);
    assert.equal(result.decisions.length, 186);

    for (const d of result.decisions) {
      if (d.supplier_id) {
        assert.equal(snap.suppliers.get(d.supplier_id)?.status, 'Active');
      }
      if (d.suggested_supplier_ids) {
        for (const sid of d.suggested_supplier_ids.split(';').filter(Boolean)) {
          assert.equal(snap.suppliers.get(sid)?.status, 'Active');
        }
      }
    }
  });

  it('Example 1: Contract PO — PR-26-00019/1 (MS sheet 3mm, RC-2025-011)', () => {
    const d = byKey.get('PR-26-00019/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1002');
    assert.equal(d.decision, 'PO');
    assert.equal(d.route, 'CONTRACT_PO');
    assert.equal(d.supplier_id, 'S001');
    assert.equal(Math.round(Number(d.unit_price)), 9169);
    assert.equal(d.group_value_inr, 137531);
    assert.notEqual(d.po_id, '');
  });

  it('Example 2: Contract that exists only as PDF — PR-26-00045/1 (RC-2026-031)', () => {
    const d = byKey.get('PR-26-00045/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1037');
    assert.equal(d.decision, 'PO');
    assert.equal(d.route, 'CONTRACT_PO');
    assert.equal(d.supplier_id, 'S021');
    assert.equal(Math.round(Number(d.unit_price)), 2439);
    assert.equal(d.group_value_inr, 26829);
    assert.ok(d.reason.includes('RC-2026-031'));
  });

  it('Example 3: Contract ceiling nearly used up -> RFQ — PR-26-00004/1 & PR-26-00026/1', () => {
    const d1 = byKey.get('PR-26-00004/1')!;
    const d2 = byKey.get('PR-26-00026/1')!;
    assert.equal(d1.resolved_item_code, 'ITM-1022');
    assert.equal(d2.resolved_item_code, 'ITM-1022');
    assert.equal(d1.group_id, d2.group_id);
    assert.equal(d1.decision, 'SOURCING_REQUEST');
    assert.equal(d1.route, 'RFQ');
    assert.equal(d1.group_value_inr, 220256);
    assert.equal(d1.suggested_supplier_ids, 'S014;S013;S016');
  });

  it('Example 4: Two contracts for same item — PR-26-00034/1 & PR-26-00032/1 (RC-2026-013)', () => {
    const d1 = byKey.get('PR-26-00034/1')!;
    const d2 = byKey.get('PR-26-00032/1')!;
    assert.equal(d1.group_id, d2.group_id);
    assert.equal(d1.decision, 'PO');
    assert.equal(d1.route, 'CONTRACT_PO');
    assert.equal(d1.supplier_id, 'S007');
    assert.equal(Number(d1.unit_price), 7.06);
    assert.equal(d1.group_value_inr, 32547);
  });

  it('Example 5: Split PRs clubbed into one requirement — PR-26-00146/1, 00144/1, 00145/1', () => {
    const d1 = byKey.get('PR-26-00146/1')!;
    const d2 = byKey.get('PR-26-00144/1')!;
    const d3 = byKey.get('PR-26-00145/1')!;
    assert.equal(d1.group_id, d2.group_id);
    assert.equal(d2.group_id, d3.group_id);
    assert.equal(d1.decision, 'PO');
    assert.equal(d1.route, 'SPOT_PO');
    assert.equal(d1.supplier_id, 'S024');
    assert.equal(Math.round(Number(d1.unit_price)), 166);
    assert.equal(d1.group_value_inr, 126472);
  });

  it('Example 6: Same item, different plants -> NOT clubbed, Valuation (21.19) vs Ref Price (21.59)', () => {
    const dPun = byKey.get('PR-26-00106/1')!;
    const dChk = byKey.get('PR-26-00103/1')!;
    assert.equal(dPun.resolved_item_code, 'ITM-1044');
    assert.equal(dChk.resolved_item_code, 'ITM-1044');
    assert.notEqual(dPun.group_id, dChk.group_id);
    assert.equal(dPun.decision, 'PO');
    assert.equal(dPun.route, 'SPOT_PO');
    assert.equal(dPun.supplier_id, 'S027');
    assert.equal(Number(dPun.unit_price), 21.59);
    assert.equal(dPun.group_value_inr, 156170);
  });

  it('Example 7: Free-text item matched — PR-26-00088/1 (hyd hose 1/2 inch 2 wire)', () => {
    const d = byKey.get('PR-26-00088/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1035');
    assert.equal(d.decision, 'PO');
    assert.equal(d.route, 'SPOT_PO');
    assert.equal(d.supplier_id, 'S023');
    assert.equal(Math.round(Number(d.unit_price)), 392);
    assert.equal(d.group_value_inr, 97955);
  });

  it('Example 8: Emergency PO — PR-26-00059/1 (Gearbox oil seal)', () => {
    const d = byKey.get('PR-26-00059/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1026');
    assert.equal(d.decision, 'PO');
    assert.equal(d.route, 'EMERGENCY_PO');
    assert.equal(d.supplier_id, 'S014');
    assert.equal(Math.round(Number(d.unit_price)), 106);
    assert.equal(d.group_value_inr, 253184);
  });

  it('Example 9: RFQ above PO limit — PR-26-00089/1 (CMM calibration service)', () => {
    const d = byKey.get('PR-26-00089/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1066');
    assert.equal(d.decision, 'SOURCING_REQUEST');
    assert.equal(d.route, 'RFQ');
    assert.equal(d.group_value_inr, 336562);
    assert.equal(d.suggested_supplier_ids, 'S043;S044;S042');
  });

  it('Example 10: RFQ small but never bought from Active supplier — PR-26-00050/1', () => {
    const d = byKey.get('PR-26-00050/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1006');
    assert.equal(d.decision, 'SOURCING_REQUEST');
    assert.equal(d.route, 'RFQ');
    assert.equal(d.group_value_inr, 80300);
    assert.equal(d.suggested_supplier_ids, 'S003;S002;S005');
  });

  it('Example 11: RFP >= 10 lakh with 4 available category suppliers — PR-26-00100/1', () => {
    const d = byKey.get('PR-26-00100/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1034');
    assert.equal(d.decision, 'SOURCING_REQUEST');
    assert.equal(d.route, 'RFP');
    assert.equal(d.group_value_inr, 2070780);
    assert.equal(d.suggested_supplier_ids, 'S020;S017;S019;S018');
  });

  it('Example 12: Capex always goes to CAPEX_SOURCING with 5 suggestions — PR-26-00047/1', () => {
    const d = byKey.get('PR-26-00047/1')!;
    assert.equal(d.resolved_item_code, 'ITM-1071');
    assert.equal(d.decision, 'SOURCING_REQUEST');
    assert.equal(d.route, 'CAPEX_SOURCING');
    assert.equal(d.group_value_inr, 6036704);
    assert.equal(d.suggested_supplier_ids, 'S045;S047;S020;S048;S046');
  });

  it('Example 13: New item — PR-26-00170/1 (Drinking water purifier 50 LPH)', () => {
    const d = byKey.get('PR-26-00170/1')!;
    assert.equal(d.resolved_item_code, 'NEW');
    assert.equal(d.decision, 'SOURCING_REQUEST');
    assert.equal(d.route, 'NEW_ITEM_SOURCING');
    assert.equal(d.group_value_inr, 141100);
    assert.equal(d.suggested_supplier_ids, '');
  });

  it('Example 14: Several requirements consolidated onto one PO within 24h — PR-26-00031, 00035, 00034, 00032', () => {
    const d31 = byKey.get('PR-26-00031/1')!;
    const d35 = byKey.get('PR-26-00035/1')!;
    const d34 = byKey.get('PR-26-00034/1')!;
    const d32 = byKey.get('PR-26-00032/1')!;

    assert.equal(d31.group_id, d35.group_id);
    assert.equal(d34.group_id, d32.group_id);
    assert.notEqual(d31.group_id, d34.group_id);

    assert.equal(d31.group_value_inr, 23227);
    assert.equal(d34.group_value_inr, 32547);

    assert.notEqual(d31.po_id, '');
    assert.equal(d31.po_id, d34.po_id);
    assert.equal(d31.supplier_id, 'S007');
  });
});
