import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'csv-parse/sync';
import {
  Contract,
  ContractLine,
  Item,
  ItemType,
  POHistoryEntry,
  Plant,
  Policy,
  PolicyRule,
  Supplier,
  SupplierStatus
} from '../engine/types.js';
import { getBaselinePolicyV5Rules } from '../engine/policy-ast.js';
import { extractContractFromPdfFile } from './services/pdf-extractor.js';

export interface MasterDataSnapshot {
  plants: Map<string, Plant>;
  items: Map<string, Item>;
  suppliers: Map<string, Supplier>;
  contracts: Contract[];
  contractLines: ContractLine[];
  poHistory: POHistoryEntry[];
  policies: Policy[];
}

export function resolveKitDataRoot(): string {
  // Supports running directly from kit root or a nested data/ copy in Docker
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'master_data', 'item_master.csv'))) {
    return cwd;
  }
  if (fs.existsSync(path.join(cwd, 'data', 'master_data', 'item_master.csv'))) {
    return path.join(cwd, 'data');
  }
  return cwd;
}

export function openDatabase(dbPath?: string): DatabaseSync {
  const target =
    dbPath || process.env.DATABASE_PATH || path.join(process.cwd(), 'storage', 'procurement.db');

  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }

  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  initializeSchema(db);
  return db;
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plants (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      item_code TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      uom TEXT NOT NULL,
      category TEXT NOT NULL,
      item_type TEXT NOT NULL,
      standard_price REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(item_type);

    CREATE TABLE IF NOT EXISTS suppliers (
      supplier_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      status TEXT NOT NULL,
      on_time_pct REAL NOT NULL,
      quality_rating REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status);

    CREATE TABLE IF NOT EXISTS supplier_categories (
      supplier_id TEXT NOT NULL,
      category TEXT NOT NULL,
      PRIMARY KEY (supplier_id, category),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id)
    );
    CREATE INDEX IF NOT EXISTS idx_supplier_cats ON supplier_categories(category);

    CREATE TABLE IF NOT EXISTS po_history (
      po_number TEXT NOT NULL,
      po_date TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      item_code TEXT NOT NULL,
      quantity REAL NOT NULL,
      uom TEXT NOT NULL,
      unit_price REAL NOT NULL,
      plant TEXT NOT NULL,
      delivered_on_time INTEGER NOT NULL,
      PRIMARY KEY (po_number, item_code),
      FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id),
      FOREIGN KEY (item_code) REFERENCES items(item_code),
      FOREIGN KEY (plant) REFERENCES plants(code)
    );
    CREATE INDEX IF NOT EXISTS idx_po_hist_item_date ON po_history(item_code, po_date DESC);
    CREATE INDEX IF NOT EXISTS idx_po_hist_supp_item ON po_history(supplier_id, item_code);

    CREATE TABLE IF NOT EXISTS contracts (
      contract_id TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      value_cap REAL NOT NULL,
      initial_consumed_value REAL NOT NULL DEFAULT 0.0,
      current_consumed_value REAL NOT NULL DEFAULT 0.0,
      source TEXT NOT NULL,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id)
    );

    CREATE TABLE IF NOT EXISTS contract_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id TEXT NOT NULL,
      item_code TEXT NOT NULL,
      description TEXT NOT NULL,
      uom TEXT NOT NULL,
      rate REAL NOT NULL,
      UNIQUE(contract_id, item_code),
      FOREIGN KEY (contract_id) REFERENCES contracts(contract_id) ON DELETE CASCADE,
      FOREIGN KEY (item_code) REFERENCES items(item_code)
    );
    CREATE INDEX IF NOT EXISTS idx_contract_lines_item ON contract_lines(item_code);

    CREATE TABLE IF NOT EXISTS policies (
      policy_id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_code TEXT NOT NULL,
      version TEXT NOT NULL,
      title TEXT NOT NULL,
      effective_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      summary_diff TEXT,
      source_text TEXT,
      clubbing_creation_window_days INTEGER NOT NULL DEFAULT 14,
      clubbing_need_by_window_days INTEGER NOT NULL DEFAULT 7,
      po_consolidation_window_hours INTEGER NOT NULL DEFAULT 24,
      active_history_lookback_days INTEGER NOT NULL DEFAULT 365,
      psl_lookback_days INTEGER NOT NULL DEFAULT 548,
      psl_recency_high_days INTEGER NOT NULL DEFAULT 90,
      psl_recency_med_days INTEGER NOT NULL DEFAULT 365
    );

    CREATE TABLE IF NOT EXISTS policy_rules (
      rule_id INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id INTEGER NOT NULL,
      clause_number TEXT NOT NULL,
      priority_order INTEGER NOT NULL,
      rule_name TEXT NOT NULL,
      conditions_json TEXT NOT NULL,
      outcome TEXT NOT NULL,
      route TEXT NOT NULL,
      supplier_strategy TEXT NOT NULL,
      supplier_suggestion_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      FOREIGN KEY (policy_id) REFERENCES policies(policy_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_policy_rules_priority ON policy_rules(policy_id, priority_order ASC);

    CREATE TABLE IF NOT EXISTS pr_batches (
      batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      policy_version_at_run TEXT NOT NULL,
      total_lines INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      pr_no TEXT NOT NULL,
      pr_line INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      requester TEXT NOT NULL,
      department TEXT NOT NULL,
      plant TEXT NOT NULL,
      raw_item_code TEXT,
      description TEXT NOT NULL,
      quantity REAL NOT NULL,
      uom TEXT NOT NULL,
      estimated_unit_price REAL,
      need_by_date TEXT NOT NULL,
      urgency TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'BATCH',
      FOREIGN KEY (batch_id) REFERENCES pr_batches(batch_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      group_id TEXT NOT NULL,
      po_id TEXT,
      resolved_item_code TEXT NOT NULL,
      plant TEXT NOT NULL,
      first_created_at TEXT NOT NULL,
      first_need_by_date TEXT NOT NULL,
      total_quantity REAL NOT NULL,
      is_emergency INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL,
      route TEXT NOT NULL,
      supplier_id TEXT,
      unit_price TEXT,
      group_value_inr INTEGER NOT NULL,
      suggested_supplier_ids TEXT,
      policy_version TEXT NOT NULL,
      clause_applied TEXT NOT NULL,
      reason TEXT NOT NULL,
      reference_doc TEXT,
      lines_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
      actioned_by TEXT,
      actioned_at TEXT,
      override_decision TEXT,
      override_route TEXT,
      override_supplier_id TEXT,
      override_comment TEXT,
      created_order_ref TEXT,
      FOREIGN KEY (batch_id) REFERENCES pr_batches(batch_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_requirements_batch ON requirements(batch_id);
    CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements(status);

    CREATE TABLE IF NOT EXISTS batch_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      pr_no TEXT NOT NULL,
      pr_line INTEGER NOT NULL,
      resolved_item_code TEXT NOT NULL,
      group_id TEXT NOT NULL,
      po_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      route TEXT NOT NULL,
      supplier_id TEXT NOT NULL,
      unit_price TEXT NOT NULL,
      group_value_inr INTEGER NOT NULL,
      suggested_supplier_ids TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      reason TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES pr_batches(batch_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_batch_decisions_batch ON batch_decisions(batch_id);

    CREATE TABLE IF NOT EXISTS purchase_orders (
      po_ref TEXT PRIMARY KEY,
      supplier_id TEXT NOT NULL,
      plant TEXT NOT NULL,
      route TEXT NOT NULL,
      total_value_inr REAL NOT NULL,
      requirement_ids_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sourcing_requests (
      sr_ref TEXT PRIMARY KEY,
      route TEXT NOT NULL,
      requirement_id INTEGER NOT NULL,
      group_id TEXT NOT NULL,
      item_code TEXT NOT NULL,
      plant TEXT NOT NULL,
      estimated_value_inr REAL NOT NULL,
      suggested_supplier_ids TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      slots_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'COLLECTING'
    );
  `);
}

function readCsvRecords(filePath: string): Record<string, string>[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true
  }) as Record<string, string>[];
}

export async function seedDatabase(
  db: DatabaseSync,
  dataRoot = resolveKitDataRoot()
): Promise<{
  plants: number;
  items: number;
  categories: number;
  suppliers: number;
  poHistory: number;
  contracts: number;
  contractLines: number;
  policies: number;
  policyRules: number;
}> {
  // 1. Plants
  const plantRows = readCsvRecords(path.join(dataRoot, 'master_data', 'plants.csv'));
  const insertPlant = db.prepare(
    'INSERT OR REPLACE INTO plants (code, name) VALUES (?, ?)'
  );
  for (const row of plantRows) {
    insertPlant.run(row.plant, row.name);
  }

  // 2. Items
  const itemRows = readCsvRecords(path.join(dataRoot, 'master_data', 'item_master.csv'));
  const insertItem = db.prepare(
    'INSERT OR REPLACE INTO items (item_code, description, uom, category, item_type, standard_price) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const row of itemRows) {
    insertItem.run(
      row.item_code,
      row.description,
      row.uom,
      row.category,
      row.item_type,
      Number(row.standard_price)
    );
  }

  // 3. Suppliers & Categories
  const supplierRows = readCsvRecords(path.join(dataRoot, 'master_data', 'supplier_master.csv'));
  const insertSupplier = db.prepare(
    'INSERT OR REPLACE INTO suppliers (supplier_id, name, city, status, on_time_pct, quality_rating) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertSuppCat = db.prepare(
    'INSERT OR IGNORE INTO supplier_categories (supplier_id, category) VALUES (?, ?)'
  );
  for (const row of supplierRows) {
    insertSupplier.run(
      row.supplier_id,
      row.name,
      row.city,
      row.status,
      Number(row.on_time_pct),
      Number(row.quality_rating)
    );
    const cats = row.categories
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean);
    for (const cat of cats) {
      insertSuppCat.run(row.supplier_id, cat);
    }
  }

  // 4. PO History
  const poRows = readCsvRecords(path.join(dataRoot, 'master_data', 'po_history.csv'));
  const insertPO = db.prepare(
    `INSERT OR REPLACE INTO po_history
     (po_number, po_date, supplier_id, item_code, quantity, uom, unit_price, plant, delivered_on_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of poRows) {
    const onTime = String(row.delivered_on_time).toLowerCase() === 'true' ? 1 : 0;
    insertPO.run(
      row.po_number,
      row.po_date,
      row.supplier_id,
      row.item_code,
      Number(row.quantity),
      row.uom,
      Number(row.unit_price),
      row.plant,
      onTime
    );
  }

  // 5. Contract Register & Lines
  const contractRows = readCsvRecords(path.join(dataRoot, 'contracts', 'contract_register.csv'));
  const registerIds = new Set<string>();
  const insertContract = db.prepare(
    `INSERT OR IGNORE INTO contracts
     (contract_id, supplier_id, supplier_name, start_date, end_date, value_cap, initial_consumed_value, current_consumed_value, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of contractRows) {
    registerIds.add(row.contract_id);
    const consumed = Number(row.consumed_value);
    insertContract.run(
      row.contract_id,
      row.supplier_id,
      row.supplier_name,
      row.start_date,
      row.end_date,
      Number(row.value_cap),
      consumed,
      consumed,
      'REGISTER_CSV'
    );
  }

  const contractLineRows = readCsvRecords(path.join(dataRoot, 'contracts', 'contract_lines.csv'));
  const insertContractLine = db.prepare(
    `INSERT OR IGNORE INTO contract_lines
     (contract_id, item_code, description, uom, rate)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const row of contractLineRows) {
    insertContractLine.run(
      row.contract_id,
      row.item_code,
      row.description,
      row.uom,
      Number(row.rate)
    );
  }

  // 6. Auto-ingest post-register signed PDF contracts (Clause 4.4: RC-2026-031, RC-2026-033)
  const pdfDir = path.join(dataRoot, 'contracts', 'pdf');
  if (fs.existsSync(pdfDir)) {
    const pdfFiles = fs
      .readdirSync(pdfDir)
      .filter((f) => f.toLowerCase().endsWith('.pdf'))
      .sort();

    for (const pdfFile of pdfFiles) {
      const baseId = path.basename(pdfFile, '.pdf');
      if (registerIds.has(baseId)) continue;

      const extracted = await extractContractFromPdfFile(path.join(pdfDir, pdfFile));
      if (extracted.contract_id && extracted.supplier_id && extracted.start_date && extracted.end_date) {
        insertContract.run(
          extracted.contract_id,
          extracted.supplier_id,
          extracted.supplier_name,
          extracted.start_date,
          extracted.end_date,
          extracted.value_cap,
          0,
          0,
          'SIGNED_PDF'
        );
        for (const line of extracted.lines) {
          insertContractLine.run(
            extracted.contract_id,
            line.item_code,
            line.description,
            line.uom,
            line.rate
          );
        }
      }
    }
  }

  // 7. Seed Baseline Policy v5.0 if no policy exists yet
  const existingPolicyCount = (
    db.prepare('SELECT COUNT(*) as cnt FROM policies').get() as { cnt: number }
  ).cnt;

  if (existingPolicyCount === 0) {
    const insertPolicy = db.prepare(
      `INSERT INTO policies
       (document_code, version, title, effective_date, status, created_at, approved_by, approved_at, summary_diff,
        clubbing_creation_window_days, clubbing_need_by_window_days, po_consolidation_window_hours,
        active_history_lookback_days, psl_lookback_days, psl_recency_high_days, psl_recency_med_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = insertPolicy.run(
      'CORVO-PROC-POL-04',
      '5.0',
      'Corvo Engineering Procurement Policy v5.0',
      '2026-04-01',
      'ACTIVE',
      '2026-04-01T00:00:00Z',
      'Head of Procurement',
      '2026-04-01T00:00:00Z',
      'Baseline Policy v5.0 seeded from Corvo_Procurement_Policy.pdf',
      14,
      7,
      24,
      365,
      548,
      90,
      365
    );
    const policyId = Number(result.lastInsertRowid);

    const insertRule = db.prepare(
      `INSERT INTO policy_rules
       (policy_id, clause_number, priority_order, rule_name, conditions_json, outcome, route, supplier_strategy, supplier_suggestion_count, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const rule of getBaselinePolicyV5Rules()) {
      insertRule.run(
        policyId,
        rule.clause_number,
        rule.priority_order,
        rule.rule_name,
        JSON.stringify(rule.conditions),
        rule.outcome,
        rule.route,
        rule.supplier_strategy,
        rule.supplier_suggestion_count,
        rule.notes || null
      );
    }
  }

  return getSeedCounts(db);
}

export function getSeedCounts(db: DatabaseSync) {
  const count = (sql: string) => (db.prepare(sql).get() as { cnt: number }).cnt;
  return {
    plants: count('SELECT COUNT(*) as cnt FROM plants'),
    items: count('SELECT COUNT(*) as cnt FROM items'),
    categories: count('SELECT COUNT(DISTINCT category) as cnt FROM items'),
    suppliers: count('SELECT COUNT(*) as cnt FROM suppliers'),
    poHistory: count('SELECT COUNT(*) as cnt FROM po_history'),
    contracts: count('SELECT COUNT(*) as cnt FROM contracts'),
    contractLines: count('SELECT COUNT(*) as cnt FROM contract_lines'),
    policies: count('SELECT COUNT(*) as cnt FROM policies'),
    policyRules: count('SELECT COUNT(*) as cnt FROM policy_rules')
  };
}

export function loadMasterDataSnapshot(db: DatabaseSync): MasterDataSnapshot {
  const plants = new Map<string, Plant>();
  for (const r of db.prepare('SELECT code, name FROM plants').all() as Array<{
    code: string;
    name: string;
  }>) {
    plants.set(r.code, { code: r.code, name: r.name });
  }

  const items = new Map<string, Item>();
  for (const r of db
    .prepare('SELECT item_code, description, uom, category, item_type, standard_price FROM items')
    .all() as Array<{
    item_code: string;
    description: string;
    uom: string;
    category: string;
    item_type: ItemType;
    standard_price: number;
  }>) {
    items.set(r.item_code, { ...r });
  }

  const suppCats = new Map<string, string[]>();
  for (const r of db
    .prepare('SELECT supplier_id, category FROM supplier_categories')
    .all() as Array<{ supplier_id: string; category: string }>) {
    const list = suppCats.get(r.supplier_id) || [];
    list.push(r.category);
    suppCats.set(r.supplier_id, list);
  }

  const suppliers = new Map<string, Supplier>();
  for (const r of db
    .prepare('SELECT supplier_id, name, city, status, on_time_pct, quality_rating FROM suppliers')
    .all() as Array<{
    supplier_id: string;
    name: string;
    city: string;
    status: SupplierStatus;
    on_time_pct: number;
    quality_rating: number;
  }>) {
    suppliers.set(r.supplier_id, {
      ...r,
      categories: suppCats.get(r.supplier_id) || []
    });
  }

  const contracts = (
    db
      .prepare(
        `SELECT contract_id, supplier_id, supplier_name, start_date, end_date,
                value_cap, initial_consumed_value, current_consumed_value, source
         FROM contracts ORDER BY contract_id ASC`
      )
      .all() as unknown as Contract[]
  ).map((c) => ({
    ...c,
    // Reset working consumed value to baseline snapshot for deterministic batch runs
    current_consumed_value: c.initial_consumed_value
  }));

  const contractLines = db
    .prepare('SELECT contract_id, item_code, description, uom, rate FROM contract_lines')
    .all() as unknown as ContractLine[];

  const poHistory = (
    db
      .prepare(
        `SELECT po_number, po_date, supplier_id, item_code, quantity, uom, unit_price, plant, delivered_on_time
         FROM po_history`
      )
      .all() as Array<{
      po_number: string;
      po_date: string;
      supplier_id: string;
      item_code: string;
      quantity: number;
      uom: string;
      unit_price: number;
      plant: string;
      delivered_on_time: number;
    }>
  ).map((r) => ({
    ...r,
    delivered_on_time: r.delivered_on_time === 1
  }));

  const policies = loadAllPolicies(db);

  return {
    plants,
    items,
    suppliers,
    contracts,
    contractLines,
    poHistory,
    policies
  };
}

export function loadAllPolicies(db: DatabaseSync): Policy[] {
  const policyRows = db
    .prepare('SELECT * FROM policies ORDER BY effective_date DESC, policy_id DESC')
    .all() as Array<Record<string, unknown>>;

  const ruleStmt = db.prepare(
    'SELECT * FROM policy_rules WHERE policy_id = ? ORDER BY priority_order ASC, rule_id ASC'
  );

  return policyRows.map((p) => {
    const rawRules = ruleStmt.all(Number(p.policy_id)) as Array<Record<string, unknown>>;
    const rules: PolicyRule[] = rawRules.map((r) => ({
      rule_id: Number(r.rule_id),
      policy_id: Number(r.policy_id),
      clause_number: String(r.clause_number),
      priority_order: Number(r.priority_order),
      rule_name: String(r.rule_name),
      conditions: JSON.parse(String(r.conditions_json)),
      outcome: String(r.outcome) as 'PO' | 'SOURCING_REQUEST',
      route: String(r.route),
      supplier_strategy: String(r.supplier_strategy) as PolicyRule['supplier_strategy'],
      supplier_suggestion_count: Number(r.supplier_suggestion_count),
      notes: r.notes ? String(r.notes) : undefined
    }));

    return {
      policy_id: Number(p.policy_id),
      document_code: String(p.document_code),
      version: String(p.version),
      title: String(p.title),
      effective_date: String(p.effective_date),
      status: String(p.status) as Policy['status'],
      created_at: String(p.created_at),
      approved_by: p.approved_by ? String(p.approved_by) : null,
      approved_at: p.approved_at ? String(p.approved_at) : null,
      summary_diff: p.summary_diff ? String(p.summary_diff) : null,
      clubbing_creation_window_days: Number(p.clubbing_creation_window_days),
      clubbing_need_by_window_days: Number(p.clubbing_need_by_window_days),
      po_consolidation_window_hours: Number(p.po_consolidation_window_hours),
      active_history_lookback_days: Number(p.active_history_lookback_days),
      psl_lookback_days: Number(p.psl_lookback_days),
      psl_recency_high_days: Number(p.psl_recency_high_days),
      psl_recency_med_days: Number(p.psl_recency_med_days),
      rules
    };
  });
}
