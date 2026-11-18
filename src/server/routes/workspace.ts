import { Router } from 'express';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot } from '../db.js';
import { rankPreferredSuppliers } from '../../engine/preferred-suppliers.js';
import { resolvePolicyForDate } from '../../engine/waterfall-evaluator.js';
import { extractDateOnly } from '../../engine/date-utils.js';

const ApproveSchema = z.object({
  actor: z.string().min(1).default('Buyer')
});

const OverrideSchema = z.object({
  actor: z.string().min(1).default('Buyer'),
  comment: z.string().trim().min(3, 'Override requires a written reason (minimum 3 characters, Policy Clause 8.1).'),
  override_decision: z.enum(['PO', 'SOURCING_REQUEST', 'NOT_PROCESSED']),
  override_route: z.string().min(1),
  override_supplier_id: z.string().optional().nullable()
});

export function createWorkspaceRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * GET /api/requirements?batch_id=...&status=...&decision=...&route=...&plant=...
   */
  router.get('/requirements', (req, res) => {
    const snap = loadMasterDataSnapshot(db);

    let batchId = req.query.batch_id ? Number(req.query.batch_id) : null;
    if (!batchId && req.query.all !== 'true') {
      const latest = db
        .prepare('SELECT batch_id FROM pr_batches ORDER BY batch_id DESC LIMIT 1')
        .get() as { batch_id: number } | undefined;
      batchId = latest ? latest.batch_id : null;
    }

    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (batchId !== null) {
      // Include both the selected batch AND standalone chat PR requirements (batch_id IS NULL)
      conditions.push('(batch_id = ? OR batch_id IS NULL)');
      params.push(batchId);
    }
    if (typeof req.query.status === 'string' && req.query.status) {
      conditions.push('status = ?');
      params.push(req.query.status);
    }
    if (typeof req.query.decision === 'string' && req.query.decision) {
      conditions.push('decision = ?');
      params.push(req.query.decision);
    }
    if (typeof req.query.route === 'string' && req.query.route) {
      conditions.push('route = ?');
      params.push(req.query.route);
    }
    if (typeof req.query.plant === 'string' && req.query.plant) {
      conditions.push('plant = ?');
      params.push(req.query.plant);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM requirements ${whereClause}
         ORDER BY CASE WHEN batch_id IS NULL THEN 0 ELSE 1 END ASC, id DESC`
      )
      .all(...params) as Array<Record<string, unknown>>;

    const enriched = rows.map((r) => {
      const itemCode = String(r.resolved_item_code);
      const item = snap.items.get(itemCode);
      const supplierId = r.supplier_id ? String(r.supplier_id) : '';
      const supplier = supplierId ? snap.suppliers.get(supplierId) : null;
      const reqDate = extractDateOnly(String(r.first_created_at));
      const reqPolicy = resolvePolicyForDate(snap.policies, reqDate);

      const psl =
        itemCode !== 'NEW' && item
          ? rankPreferredSuppliers(
              itemCode,
              reqDate,
              snap.suppliers,
              snap.poHistory,
              snap.contracts,
              snap.contractLines,
              {
                lookbackDays: reqPolicy?.psl_lookback_days ?? 548,
                recencyHighDays: reqPolicy?.psl_recency_high_days ?? 90,
                recencyMedDays: reqPolicy?.psl_recency_med_days ?? 365
              }
            ).slice(0, 5)
          : [];

      const suggestedIds = r.suggested_supplier_ids
        ? String(r.suggested_supplier_ids).split(';').filter(Boolean)
        : [];
      const suggestedSuppliers = suggestedIds.map((sid) => {
        const s = snap.suppliers.get(sid);
        const pslMatch = psl.find((p) => p.supplier_id === sid);
        return {
          supplier_id: sid,
          name: s?.name ?? sid,
          on_time_pct: s?.on_time_pct ?? 0,
          quality_rating: s?.quality_rating ?? 0,
          rank: pslMatch?.rank ?? null,
          composite_score: pslMatch?.composite_score ?? null,
          source: pslMatch ? 'Preferred List' : 'Category Fallback (Clause 6.4)'
        };
      });

      return {
        id: Number(r.id),
        batch_id: r.batch_id !== null ? Number(r.batch_id) : null,
        group_id: String(r.group_id),
        po_id: r.po_id ? String(r.po_id) : '',
        resolved_item_code: itemCode,
        item_description: item?.description ?? (JSON.parse(String(r.lines_json))[0]?.description || itemCode),
        item_category: item?.category ?? 'Uncataloged',
        item_type: item?.item_type ?? 'New Item',
        uom: item?.uom ?? (JSON.parse(String(r.lines_json))[0]?.uom || 'NOS'),
        plant: String(r.plant),
        first_created_at: String(r.first_created_at),
        first_need_by_date: String(r.first_need_by_date),
        total_quantity: Number(r.total_quantity),
        is_emergency: Number(r.is_emergency) === 1,
        decision: String(r.decision),
        route: String(r.route),
        supplier_id: supplierId,
        supplier_name: supplier?.name ?? '',
        unit_price: r.unit_price ? String(r.unit_price) : '',
        group_value_inr: Number(r.group_value_inr),
        suggested_supplier_ids: suggestedIds.join(';'),
        suggested_suppliers: suggestedSuppliers,
        policy_version: String(r.policy_version),
        clause_applied: String(r.clause_applied),
        reason: String(r.reason),
        reference_doc: r.reference_doc ? String(r.reference_doc) : '',
        lines: JSON.parse(String(r.lines_json)),
        status: String(r.status),
        actioned_by: r.actioned_by ? String(r.actioned_by) : null,
        actioned_at: r.actioned_at ? String(r.actioned_at) : null,
        override_decision: r.override_decision ? String(r.override_decision) : null,
        override_route: r.override_route ? String(r.override_route) : null,
        override_supplier_id: r.override_supplier_id ? String(r.override_supplier_id) : null,
        override_comment: r.override_comment ? String(r.override_comment) : null,
        created_order_ref: r.created_order_ref ? String(r.created_order_ref) : null,
        preferred_supplier_breakdown: psl
      };
    });

    res.json({ batch_id: batchId, count: enriched.length, requirements: enriched });
  });

  /**
   * POST /api/requirements/:id/approve
   * Creates the PO or RFQ/RFP sourcing request and logs the audit entry.
   */
  router.post('/requirements/:id/approve', (req, res) => {
    const id = Number(req.params.id);
    const parsed = ApproveSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid approval payload' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM requirements WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      res.status(404).json({ error: `Requirement #${id} not found.` });
      return;
    }

    const decision = String(row.decision);
    if (decision === 'NOT_PROCESSED') {
      res.status(400).json({
        error: 'NOT_PROCESSED anomaly rows cannot be approved directly. Use Override with a written comment.'
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const actor = parsed.data.actor;
    let createdOrderRef = '';

    if (decision === 'PO') {
      const basePoId = row.po_id ? String(row.po_id) : `PO-LIVE-${id}`;
      // Namespace persisted PO ref by batch so Batch 1's PO-0001 never collides with Batch 2's PO-0001
      const poRef = row.batch_id !== null ? `B${row.batch_id}-${basePoId}` : basePoId;
      createdOrderRef = poRef;
      const existingPO = db
        .prepare('SELECT * FROM purchase_orders WHERE po_ref = ?')
        .get(poRef) as Record<string, unknown> | undefined;

      if (existingPO) {
        const reqIds = JSON.parse(String(existingPO.requirement_ids_json)) as number[];
        if (!reqIds.includes(id)) {
          reqIds.push(id);
          const newTotal = Number(existingPO.total_value_inr) + Number(row.group_value_inr);
          db.prepare(
            'UPDATE purchase_orders SET requirement_ids_json = ?, total_value_inr = ? WHERE po_ref = ?'
          ).run(JSON.stringify(reqIds), newTotal, poRef);
        }
      } else {
        db.prepare(
          `INSERT INTO purchase_orders
           (po_ref, supplier_id, plant, route, total_value_inr, requirement_ids_json, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          poRef,
          String(row.supplier_id || ''),
          String(row.plant),
          String(row.route),
          Number(row.group_value_inr),
          JSON.stringify([id]),
          actor,
          nowIso
        );
      }
    } else {
      const prefix = String(row.route).startsWith('RFP')
        ? 'RFP'
        : String(row.route).startsWith('CAPEX')
          ? 'CAPEX'
          : String(row.route).startsWith('NEW')
            ? 'NEW-SR'
            : 'RFQ';
      createdOrderRef = `${prefix}-${String(id).padStart(4, '0')}`;
      db.prepare(
        `INSERT OR REPLACE INTO sourcing_requests
         (sr_ref, route, requirement_id, group_id, item_code, plant, estimated_value_inr, suggested_supplier_ids, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        createdOrderRef,
        String(row.route),
        id,
        String(row.group_id),
        String(row.resolved_item_code),
        String(row.plant),
        Number(row.group_value_inr),
        String(row.suggested_supplier_ids || ''),
        actor,
        nowIso
      );
    }

    db.prepare(
      `UPDATE requirements
       SET status = 'APPROVED', actioned_by = ?, actioned_at = ?, created_order_ref = ?
       WHERE id = ?`
    ).run(actor, nowIso, createdOrderRef, id);

    db.prepare(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
       VALUES ('REQUIREMENT', ?, 'APPROVED', ?, ?, ?)`
    ).run(
      String(row.group_id),
      actor,
      nowIso,
      JSON.stringify({
        requirement_id: id,
        decision,
        route: row.route,
        created_order_ref: createdOrderRef,
        policy_version: row.policy_version,
        clause_applied: row.clause_applied
      })
    );

    res.json({
      id,
      status: 'APPROVED',
      created_order_ref: createdOrderRef,
      actioned_by: actor,
      actioned_at: nowIso
    });
  });

  /**
   * POST /api/requirements/:id/override
   * Clause 8.1: Mandatory written reason; preserves original decision alongside override.
   */
  router.post('/requirements/:id/override', (req, res) => {
    const id = Number(req.params.id);
    const parsed = OverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Override requires a valid comment, override_decision, and override_route.',
        details: parsed.error.flatten()
      });
      return;
    }

    const row = db
      .prepare('SELECT * FROM requirements WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: `Requirement #${id} not found.` });
      return;
    }

    const { actor, comment, override_decision, override_route, override_supplier_id } = parsed.data;
    const effectiveSupplierId =
      override_supplier_id?.trim().toUpperCase() || String(row.supplier_id || '').trim().toUpperCase();

    // Enforce Clause 5.7 & require a valid Active supplier when overriding to a PO
    if (override_decision === 'PO' && !effectiveSupplierId) {
      res.status(400).json({
        error: 'Overriding to a PO requires selecting an Active supplier.'
      });
      return;
    }

    if (effectiveSupplierId && (override_supplier_id || override_decision === 'PO')) {
      const snap = loadMasterDataSnapshot(db);
      const supp = snap.suppliers.get(effectiveSupplierId);
      if (!supp) {
        res.status(400).json({ error: `Supplier '${effectiveSupplierId}' not found.` });
        return;
      }
      if (supp.status !== 'Active') {
        res.status(400).json({
          error: `Policy Clause 5.7 violation: Supplier ${supp.supplier_id} (${supp.name}) is ${supp.status} and cannot receive a PO or sourcing event.`
        });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    let createdOrderRef: string | null = null;

    if (override_decision === 'PO') {
      createdOrderRef = `PO-OVR-${String(id).padStart(4, '0')}`;
      db.prepare(
        `INSERT OR REPLACE INTO purchase_orders
         (po_ref, supplier_id, plant, route, total_value_inr, requirement_ids_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        createdOrderRef,
        effectiveSupplierId,
        String(row.plant),
        override_route,
        Number(row.group_value_inr),
        JSON.stringify([id]),
        actor,
        nowIso
      );
    } else if (override_decision === 'SOURCING_REQUEST') {
      createdOrderRef = `SR-OVR-${String(id).padStart(4, '0')}`;
      db.prepare(
        `INSERT OR REPLACE INTO sourcing_requests
         (sr_ref, route, requirement_id, group_id, item_code, plant, estimated_value_inr, suggested_supplier_ids, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        createdOrderRef,
        override_route,
        id,
        String(row.group_id),
        String(row.resolved_item_code),
        String(row.plant),
        Number(row.group_value_inr),
        String(row.suggested_supplier_ids || ''),
        actor,
        nowIso
      );
    }

    db.prepare(
      `UPDATE requirements
       SET status = 'OVERRIDDEN',
           actioned_by = ?,
           actioned_at = ?,
           override_decision = ?,
           override_route = ?,
           override_supplier_id = ?,
           override_comment = ?,
           created_order_ref = ?
       WHERE id = ?`
    ).run(
      actor,
      nowIso,
      override_decision,
      override_route,
      override_supplier_id?.toUpperCase() || null,
      comment,
      createdOrderRef,
      id
    );

    db.prepare(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
       VALUES ('REQUIREMENT', ?, 'OVERRIDDEN', ?, ?, ?)`
    ).run(
      String(row.group_id),
      actor,
      nowIso,
      JSON.stringify({
        requirement_id: id,
        original_decision: row.decision,
        original_route: row.route,
        original_supplier_id: row.supplier_id,
        override_decision,
        override_route,
        override_supplier_id: override_supplier_id?.toUpperCase() || null,
        comment,
        created_order_ref: createdOrderRef
      })
    );

    res.json({
      id,
      status: 'OVERRIDDEN',
      original_decision: row.decision,
      original_route: row.route,
      override_decision,
      override_route,
      override_comment: comment,
      created_order_ref: createdOrderRef,
      actioned_by: actor,
      actioned_at: nowIso
    });
  });

  /**
   * GET /api/orders
   */
  router.get('/orders', (_req, res) => {
    const purchaseOrders = db
      .prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC')
      .all();
    const sourcingRequests = db
      .prepare('SELECT * FROM sourcing_requests ORDER BY created_at DESC')
      .all();
    res.json({ purchase_orders: purchaseOrders, sourcing_requests: sourcingRequests });
  });

  /**
   * GET /api/audit-logs
   */
  router.get('/audit-logs', (_req, res) => {
    const logs = db
      .prepare('SELECT * FROM audit_logs ORDER BY log_id DESC LIMIT 200')
      .all() as Array<Record<string, unknown>>;

    res.json({
      logs: logs.map((l) => ({
        log_id: Number(l.log_id),
        entity_type: String(l.entity_type),
        entity_id: String(l.entity_id),
        action: String(l.action),
        actor: String(l.actor),
        timestamp: String(l.timestamp),
        details: JSON.parse(String(l.details_json))
      }))
    });
  });

  return router;
}
