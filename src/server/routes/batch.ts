import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot, resolveKitDataRoot } from '../db.js';
import { parsePrBatchCsv, serializeDecisionsCsv } from '../services/csv-utils.js';
import { runProcurementPipeline } from '../../engine/pipeline.js';
import { PRLine } from '../../engine/types.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

function executeAndPersistBatch(
  db: DatabaseSync,
  prLines: PRLine[],
  filename: string
) {
  const snap = loadMasterDataSnapshot(db);
  const activePolicies = snap.policies
    .filter((p) => p.status === 'ACTIVE' || p.status === 'SUPERSEDED')
    .sort((a, b) => b.effective_date.localeCompare(a.effective_date) || b.policy_id - a.policy_id);
  const latestVersion = activePolicies[0] ? `v${activePolicies[0].version}` : 'v5.0';

  const pipelineResult = runProcurementPipeline({
    prLines,
    plants: snap.plants,
    items: snap.items,
    suppliers: snap.suppliers,
    contracts: snap.contracts,
    contractLines: snap.contractLines,
    poHistory: snap.poHistory,
    policies: snap.policies
  });

  const nowIso = new Date().toISOString();

  const batchInsert = db
    .prepare(
      `INSERT INTO pr_batches (filename, uploaded_at, policy_version_at_run, total_lines)
       VALUES (?, ?, ?, ?)`
    )
    .run(filename, nowIso, latestVersion, prLines.length);
  const batchId = Number(batchInsert.lastInsertRowid);

  const insertPrLine = db.prepare(
    `INSERT INTO pr_lines
     (batch_id, pr_no, pr_line, created_at, requester, department, plant,
      raw_item_code, description, quantity, uom, estimated_unit_price, need_by_date, urgency, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BATCH')`
  );
  for (const l of prLines) {
    insertPrLine.run(
      batchId,
      l.pr_no,
      l.pr_line,
      l.created_at,
      l.requester,
      l.department,
      l.plant,
      l.raw_item_code,
      l.description,
      l.quantity,
      l.uom,
      l.estimated_unit_price,
      l.need_by_date,
      l.urgency
    );
  }

  const insertReq = db.prepare(
    `INSERT INTO requirements
     (batch_id, group_id, po_id, resolved_item_code, plant, first_created_at, first_need_by_date,
      total_quantity, is_emergency, decision, route, supplier_id, unit_price, group_value_inr,
      suggested_supplier_ids, policy_version, clause_applied, reason, reference_doc, lines_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const ev of pipelineResult.evaluatedRequirements) {
    const r = ev.requirement;
    insertReq.run(
      batchId,
      r.group_id,
      ev.po_id || null,
      r.resolved_item_code,
      r.plant,
      r.first_created_at,
      r.first_need_by_date,
      r.total_quantity,
      r.is_emergency ? 1 : 0,
      ev.decision,
      ev.route,
      ev.supplier_id || null,
      ev.unit_price || null,
      ev.group_value_inr,
      ev.suggested_supplier_ids || null,
      ev.policy_version,
      ev.clause_applied,
      ev.reason,
      ev.reference_doc || null,
      JSON.stringify(r.lines),
      'PENDING_REVIEW'
    );
  }

  for (const anom of pipelineResult.anomalyOutputs) {
    const matchingLine = prLines.find(
      (l) => l.pr_no === anom.pr_no && l.pr_line === anom.pr_line
    );
    insertReq.run(
      batchId,
      anom.group_id,
      null,
      anom.resolved_item_code,
      matchingLine?.plant || 'UNKNOWN',
      matchingLine?.created_at || nowIso,
      matchingLine?.need_by_date || nowIso.slice(0, 10),
      matchingLine?.quantity ?? 0,
      matchingLine?.urgency === 'Emergency' ? 1 : 0,
      anom.decision,
      anom.route,
      null,
      null,
      0,
      null,
      anom.policy_version,
      'ANOMALY',
      anom.reason,
      'Anomaly Guard',
      JSON.stringify(matchingLine ? [matchingLine] : []),
      'FLAGGED_EXCEPTION'
    );
  }

  const insertDec = db.prepare(
    `INSERT INTO batch_decisions
     (batch_id, pr_no, pr_line, resolved_item_code, group_id, po_id, decision, route,
      supplier_id, unit_price, group_value_inr, suggested_supplier_ids, policy_version, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const d of pipelineResult.decisions) {
    insertDec.run(
      batchId,
      d.pr_no,
      d.pr_line,
      d.resolved_item_code,
      d.group_id,
      d.po_id,
      d.decision,
      d.route,
      d.supplier_id,
      d.unit_price,
      d.group_value_inr,
      d.suggested_supplier_ids,
      d.policy_version,
      d.reason
    );
  }

  const routeCounts: Record<string, number> = {};
  const decisionCounts: Record<string, number> = {};
  for (const d of pipelineResult.decisions) {
    routeCounts[d.route] = (routeCounts[d.route] || 0) + 1;
    decisionCounts[d.decision] = (decisionCounts[d.decision] || 0) + 1;
  }

  db.prepare(
    `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
     VALUES ('BATCH', ?, 'PROCESSED', 'System', ?, ?)`
  ).run(
    String(batchId),
    nowIso,
    JSON.stringify({
      filename,
      total_lines: prLines.length,
      requirements_count: pipelineResult.evaluatedRequirements.length,
      consolidated_pos: pipelineResult.poGroups.length,
      anomalies: pipelineResult.anomalyOutputs.length,
      policy_version: latestVersion
    })
  );

  return {
    batch_id: batchId,
    filename,
    uploaded_at: nowIso,
    policy_version: latestVersion,
    summary: {
      total_lines: pipelineResult.decisions.length,
      requirements_count: pipelineResult.evaluatedRequirements.length,
      consolidated_po_count: pipelineResult.poGroups.length,
      anomalies_count: pipelineResult.anomalyOutputs.length,
      decision_counts: decisionCounts,
      route_counts: routeCounts
    },
    decisions: pipelineResult.decisions,
    po_groups: pipelineResult.poGroups
  };
}

export function createBatchRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * POST /api/process-batch
   * Accepts ANY multipart file field name (file, csv, batch, etc.), raw text/csv, or JSON { csv } / { lines }.
   */
  router.post('/process-batch', upload.any(), (req, res) => {
    try {
      let prLines: PRLine[] = [];
      let filename = 'uploaded_batch.csv';

      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const uploadedFile = files[0];

      if (uploadedFile) {
        filename = uploadedFile.originalname || filename;
        prLines = parsePrBatchCsv(uploadedFile.buffer.toString('utf-8'));
      } else if (typeof req.body === 'string' && req.body.trim().length > 0) {
        prLines = parsePrBatchCsv(req.body);
      } else if (req.body && typeof req.body === 'object') {
        if (typeof req.body.filename === 'string' && req.body.filename.trim()) {
          filename = req.body.filename.trim();
        }
        if (typeof req.body.csv === 'string') {
          prLines = parsePrBatchCsv(req.body.csv);
        } else if (Array.isArray(req.body.lines)) {
          prLines = req.body.lines as PRLine[];
        }
      }

      if (!prLines || prLines.length === 0) {
        res.status(400).json({
          error: 'No PR lines found. Upload a CSV file or provide JSON { csv } / { lines }.'
        });
        return;
      }

      res.json(executeAndPersistBatch(db, prLines, filename));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process batch';
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/process-sample-batch
   * 1-click convenience endpoint to run the kit's 186-line sample_pr_batch.csv.
   */
  router.post('/process-sample-batch', (_req, res) => {
    try {
      const samplePath = path.join(resolveKitDataRoot(), 'pr_batches', 'sample_pr_batch.csv');
      if (!fs.existsSync(samplePath)) {
        res.status(404).json({ error: 'Sample PR batch CSV not found on server.' });
        return;
      }
      const prLines = parsePrBatchCsv(fs.readFileSync(samplePath, 'utf-8'));
      res.json(executeAndPersistBatch(db, prLines, 'sample_pr_batch.csv'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process sample batch';
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/batches
   */
  router.get('/batches', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT batch_id, filename, uploaded_at, policy_version_at_run, total_lines
         FROM pr_batches ORDER BY batch_id DESC LIMIT 25`
      )
      .all();
    res.json({ batches: rows });
  });

  /**
   * GET /api/export-decisions?batch_id=1&format=csv
   */
  router.get('/export-decisions', (req, res) => {
    let batchId = req.query.batch_id ? Number(req.query.batch_id) : null;

    if (!batchId) {
      const latest = db
        .prepare('SELECT batch_id FROM pr_batches ORDER BY batch_id DESC LIMIT 1')
        .get() as { batch_id: number } | undefined;
      batchId = latest ? latest.batch_id : null;
    }

    if (!batchId) {
      res.status(404).json({ error: 'No processed batch available to export.' });
      return;
    }

    const decisions = db
      .prepare(
        `SELECT pr_no, pr_line, resolved_item_code, group_id, po_id, decision, route,
                supplier_id, unit_price, group_value_inr, suggested_supplier_ids, policy_version, reason
         FROM batch_decisions WHERE batch_id = ? ORDER BY pr_no ASC, pr_line ASC`
      )
      .all(batchId) as unknown as Array<{
      pr_no: string;
      pr_line: number;
      resolved_item_code: string;
      group_id: string;
      po_id: string;
      decision: 'PO' | 'SOURCING_REQUEST' | 'NOT_PROCESSED';
      route: string;
      supplier_id: string;
      unit_price: string;
      group_value_inr: number;
      suggested_supplier_ids: string;
      policy_version: string;
      reason: string;
    }>;

    const format = String(req.query.format || 'csv').toLowerCase();
    if (format === 'json') {
      res.json({ batch_id: batchId, decisions });
      return;
    }

    const csv = serializeDecisionsCsv(decisions);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="decisions_batch_${batchId}.csv"`
    );
    res.send(csv);
  });

  return router;
}
