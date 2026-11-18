import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, seedDatabase, loadMasterDataSnapshot } from '../server/db.js';

describe('Phase 0: Database Schema, Seeding & Signed PDF Contract Ingestion', () => {
  let db: DatabaseSync;

  before(() => {
    db = openDatabase(':memory:');
  });

  after(() => {
    db.close();
  });

  it('seeds exact master data counts idempotently across repeated runs', async () => {
    const first = await seedDatabase(db);
    const second = await seedDatabase(db);

    assert.deepEqual(first, second);
    assert.equal(first.plants, 2);
    assert.equal(first.items, 73);
    assert.equal(first.categories, 13);
    assert.equal(first.suppliers, 48);
    assert.equal(first.poHistory, 468);
    assert.equal(first.contracts, 12); // 10 register + 2 PDF-only
    assert.equal(first.contractLines, 31); // 26 register + 3 (RC-2026-031) + 2 (RC-2026-033)
    assert.equal(first.policies, 1);
    assert.equal(first.policyRules, 6);
  });

  it('extracts PDF-only contracts RC-2026-031 and RC-2026-033 accurately', () => {
    const snap = loadMasterDataSnapshot(db);

    const rc31 = snap.contracts.find((c) => c.contract_id === 'RC-2026-031');
    assert.ok(rc31);
    assert.equal(rc31.supplier_id, 'S021');
    assert.equal(rc31.start_date, '2026-11-15');
    assert.equal(rc31.end_date, '2027-11-14');
    assert.equal(rc31.value_cap, 2000000);
    assert.equal(rc31.initial_consumed_value, 0);
    assert.equal(rc31.source, 'SIGNED_PDF');

    const rc31Lines = snap.contractLines.filter((l) => l.contract_id === 'RC-2026-031');
    assert.equal(rc31Lines.length, 3);
    assert.equal(rc31Lines.find((l) => l.item_code === 'ITM-1037')?.rate, 2439.01);

    const rc33 = snap.contracts.find((c) => c.contract_id === 'RC-2026-033');
    assert.ok(rc33);
    assert.equal(rc33.supplier_id, 'S035');
    assert.equal(rc33.start_date, '2026-11-20');
    assert.equal(rc33.end_date, '2027-11-19');
    assert.equal(rc33.value_cap, 5000000);
    assert.equal(rc33.initial_consumed_value, 0);

    const rc33Lines = snap.contractLines.filter((l) => l.contract_id === 'RC-2026-033');
    assert.equal(rc33Lines.length, 2);
    assert.equal(rc33Lines.find((l) => l.item_code === 'ITM-1056')?.rate, 64654.36);
    assert.equal(rc33Lines.find((l) => l.item_code === 'ITM-1057')?.rate, 10689.51);
  });

  it('seeds baseline Policy v5.0 with 6 ordered AST rules', () => {
    const snap = loadMasterDataSnapshot(db);
    assert.equal(snap.policies.length, 1);
    const v5 = snap.policies[0];
    assert.equal(v5.version, '5.0');
    assert.equal(v5.effective_date, '2026-04-01');
    assert.equal(v5.status, 'ACTIVE');
    assert.deepEqual(
      v5.rules.map((r) => r.clause_number),
      ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6']
    );
  });
});
