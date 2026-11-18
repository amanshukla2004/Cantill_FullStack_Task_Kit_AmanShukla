import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, seedDatabase, loadMasterDataSnapshot } from '../server/db.js';
import { rankPreferredSuppliers } from '../engine/preferred-suppliers.js';

describe('Phase 1: Preferred Supplier Ranking (Section 6) — All 3/3 Worked Examples', () => {
  let db: DatabaseSync;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
  });

  after(() => {
    db.close();
  });

  it('ITM-1048 (Nitrile coated gloves as of 2026-11-01): S029 > S030, S031 Inactive excluded', () => {
    const snap = loadMasterDataSnapshot(db);
    const ranked = rankPreferredSuppliers(
      'ITM-1048',
      '2026-11-01',
      snap.suppliers,
      snap.poHistory,
      snap.contracts,
      snap.contractLines
    );
    assert.deepEqual(ranked.map((r) => r.supplier_id), ['S029', 'S030']);
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].rank, 2);
  });

  it('ITM-1036 (Pneumatic cylinder 50x100 as of 2026-11-01): S023 > S022 > S024', () => {
    const snap = loadMasterDataSnapshot(db);
    const ranked = rankPreferredSuppliers(
      'ITM-1036',
      '2026-11-01',
      snap.suppliers,
      snap.poHistory,
      snap.contracts,
      snap.contractLines
    );
    assert.deepEqual(ranked.map((r) => r.supplier_id), ['S023', 'S022', 'S024']);
  });

  it('ITM-1016 (MIG wire ER70S-6 1.2mm as of 2026-11-01): S009 > S010', () => {
    const snap = loadMasterDataSnapshot(db);
    const ranked = rankPreferredSuppliers(
      'ITM-1016',
      '2026-11-01',
      snap.suppliers,
      snap.poHistory,
      snap.contracts,
      snap.contractLines
    );
    assert.deepEqual(ranked.map((r) => r.supplier_id), ['S009', 'S010']);
  });

  it('never includes any Blocked or Inactive supplier across all 73 catalog items', () => {
    const snap = loadMasterDataSnapshot(db);
    for (const itemCode of snap.items.keys()) {
      const ranked = rankPreferredSuppliers(
        itemCode,
        '2026-11-19',
        snap.suppliers,
        snap.poHistory,
        snap.contracts,
        snap.contractLines
      );
      for (const r of ranked) {
        assert.equal(snap.suppliers.get(r.supplier_id)?.status, 'Active');
        assert.ok(r.reference_price > 0);
      }
    }
  });
});
