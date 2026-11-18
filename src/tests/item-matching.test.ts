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
import { resolveItem } from '../engine/item-resolver.js';

describe('Phase 1: Deterministic Item Matching across ALL Free-Text Lines in Sample Batch', () => {
  let db: DatabaseSync;

  before(async () => {
    db = openDatabase(':memory:');
    await seedDatabase(db);
  });

  after(() => {
    db.close();
  });

  it('resolves every single free-text PR line accurately without inventing catalog codes', () => {
    const snap = loadMasterDataSnapshot(db);
    const batchCsv = fs.readFileSync(getSamplePrBatchPath(), 'utf-8');
    const lines = parsePrBatchCsv(batchCsv).filter((l) => !l.raw_item_code);

    const expected: Record<string, string> = {
      'PR-26-00002': 'ITM-1024',
      'PR-26-00004': 'ITM-1022',
      'PR-26-00008': 'ITM-1016',
      'PR-26-00018': 'ITM-1013',
      'PR-26-00020': 'ITM-1015',
      'PR-26-00023': 'ITM-1048',
      'PR-26-00030': 'ITM-1023',
      'PR-26-00036': 'ITM-1039',
      'PR-26-00039': 'ITM-1057',
      'PR-26-00042': 'ITM-1036',
      'PR-26-00047': 'ITM-1071',
      'PR-26-00052': 'ITM-1025',
      'PR-26-00058': 'ITM-1020',
      'PR-26-00060': 'ITM-1050',
      'PR-26-00063': 'ITM-1043',
      'PR-26-00066': 'ITM-1008',
      'PR-26-00075': 'ITM-1030',
      'PR-26-00083': 'ITM-1050',
      'PR-26-00088': 'ITM-1035',
      'PR-26-00089': 'ITM-1066',
      'PR-26-00097': 'ITM-1066',
      'PR-26-00098': 'ITM-1008',
      'PR-26-00103': 'ITM-1044',
      'PR-26-00109': 'ITM-1044',
      'PR-26-00114': 'ITM-1034',
      'PR-26-00117': 'ITM-1030',
      'PR-26-00119': 'ITM-1028',
      'PR-26-00124': 'ITM-1004',
      'PR-26-00139': 'ITM-1051',
      'PR-26-00141': 'ITM-1040',
      'PR-26-00142': 'ITM-1040',
      'PR-26-00150': 'ITM-1058',
      'PR-26-00161': 'ITM-1010',
      'PR-26-00163': 'ITM-1013',
      'PR-26-00165': 'ITM-1055',
      'PR-26-00167': 'ITM-1073',
      'PR-26-00169': 'ITM-1063',
      'PR-26-00170': 'NEW',
      'PR-26-00171': 'NEW'
    };

    assert.equal(lines.length, Object.keys(expected).length);

    for (const line of lines) {
      const match = resolveItem(line.raw_item_code, line.description, snap.items);
      assert.equal(
        match.resolved_item_code,
        expected[line.pr_no],
        `Mismatch on ${line.pr_no}: "${line.description}"`
      );
    }
  });
});
