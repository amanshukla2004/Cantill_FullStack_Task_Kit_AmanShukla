import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { loadAllPolicies, loadMasterDataSnapshot } from '../db.js';
import { extractPdfRawText } from '../services/pdf-extractor.js';
import {
  PolicyAmendmentDraftSchema,
  computePolicyDiff,
  draftPolicyAmendment
} from '../services/policy-agent.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const ActivatePolicySchema = z.object({
  approved_by: z.string().min(1).default('Head of Procurement')
});

export function createPolicyRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * GET /api/policies
   * Lists all policy versions (ACTIVE, SUPERSEDED, DRAFT) with full declarative rules.
   */
  router.get('/policies', (_req, res) => {
    const policies = loadAllPolicies(db);
    const active = policies.find((p) => p.status === 'ACTIVE') || policies[0] || null;
    res.json({
      active_policy: active,
      policies
    });
  });

  /**
   * POST /api/policy/amend
   * Accepts:
   *  - multipart/form-data file (.pdf, .txt, .md) containing a new policy or amendment
   *  - JSON body { instruction: string, actor?: string } describing a change in chat
   * Generates a DRAFT policy version + plain-language diff for human approval.
   */
  router.post('/policy/amend', upload.any(), async (req, res) => {
    try {
      let amendmentText = '';
      let sourceLabel = 'Chat instruction';

      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const uploadedFile = files[0];

      if (uploadedFile) {
        sourceLabel = uploadedFile.originalname || 'Uploaded policy document';
        const isPdf =
          uploadedFile.mimetype === 'application/pdf' ||
          sourceLabel.toLowerCase().endsWith('.pdf');
        amendmentText = isPdf
          ? await extractPdfRawText(uploadedFile.buffer)
          : uploadedFile.buffer.toString('utf-8');
      } else if (req.body && typeof req.body.instruction === 'string') {
        amendmentText = req.body.instruction.trim();
      } else if (req.body && typeof req.body.text === 'string') {
        amendmentText = req.body.text.trim();
      }

      if (!amendmentText || amendmentText.trim().length < 5) {
        res.status(400).json({
          error: 'Please upload a policy document (PDF/TXT/MD) or describe the policy change in text.'
        });
        return;
      }

      const snap = loadMasterDataSnapshot(db);
      const currentPolicy =
        snap.policies.find((p) => p.status === 'ACTIVE') || snap.policies[0];
      if (!currentPolicy) {
        res.status(500).json({ error: 'No baseline active policy found in database.' });
        return;
      }

      const knownCategories = Array.from(
        new Set(Array.from(snap.items.values()).map((i) => i.category))
      ).sort();
      const knownPlants = Array.from(snap.plants.keys()).sort();

      const { draft, diff, used_ai, warnings } = await draftPolicyAmendment({
        amendmentText,
        currentPolicy,
        knownCategories,
        knownPlants
      });

      const nowIso = new Date().toISOString();
      const actor =
        typeof req.body?.actor === 'string' && req.body.actor.trim()
          ? req.body.actor.trim()
          : 'Procurement Admin';

      const cleanVersion = draft.new_version.trim().replace(/^v/i, '');
      const insertPol = db
        .prepare(
          `INSERT INTO policies
           (document_code, version, title, effective_date, status, created_at, approved_by, approved_at,
            summary_diff, source_text,
            clubbing_creation_window_days, clubbing_need_by_window_days, po_consolidation_window_hours,
            active_history_lookback_days, psl_lookback_days, psl_recency_high_days, psl_recency_med_days)
           VALUES (?, ?, ?, ?, 'DRAFT', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          currentPolicy.document_code,
          cleanVersion,
          draft.title,
          draft.effective_date,
          nowIso,
          JSON.stringify(diff.plain_language_summary),
          amendmentText.slice(0, 20000),
          draft.clubbing_creation_window_days,
          draft.clubbing_need_by_window_days,
          draft.po_consolidation_window_hours,
          draft.active_history_lookback_days,
          draft.psl_lookback_days,
          draft.psl_recency_high_days,
          draft.psl_recency_med_days
        );

      const newPolicyId = Number(insertPol.lastInsertRowid);

      const insertRule = db.prepare(
        `INSERT INTO policy_rules
         (policy_id, clause_number, priority_order, rule_name, conditions_json, outcome, route,
          supplier_strategy, supplier_suggestion_count, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of draft.rules) {
        insertRule.run(
          newPolicyId,
          r.clause_number,
          r.priority_order,
          r.rule_name,
          JSON.stringify(r.conditions),
          r.outcome,
          r.route,
          r.supplier_strategy,
          r.supplier_suggestion_count,
          r.notes || null
        );
      }

      db.prepare(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
         VALUES ('POLICY', ?, 'DRAFT_CREATED', ?, ?, ?)`
      ).run(
        `v${cleanVersion}`,
        actor,
        nowIso,
        JSON.stringify({
          policy_id: newPolicyId,
          source: sourceLabel,
          effective_date: draft.effective_date,
          used_ai,
          diff_summary: diff.plain_language_summary
        })
      );

      const savedDraft = loadAllPolicies(db).find((p) => p.policy_id === newPolicyId)!;

      res.status(201).json({
        policy_id: newPolicyId,
        draft_policy: savedDraft,
        diff,
        used_ai,
        warnings
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Policy amendment ingestion failed';
      res.status(500).json({ error: msg });
    }
  });

  /**
   * PUT /api/policy/:id
   * Allows Procurement to review/edit any rule or parameter in a DRAFT policy before activation.
   */
  router.put('/policy/:id', (req, res) => {
    const policyId = Number(req.params.id);
    const existing = loadAllPolicies(db).find((p) => p.policy_id === policyId);
    if (!existing) {
      res.status(404).json({ error: `Policy #${policyId} not found.` });
      return;
    }
    if (existing.status !== 'DRAFT') {
      res.status(400).json({ error: 'Only DRAFT policies can be edited.' });
      return;
    }

    const parsed = PolicyAmendmentDraftSchema.safeParse({
      new_version: req.body.version ?? req.body.new_version ?? existing.version,
      title: req.body.title ?? existing.title,
      effective_date: req.body.effective_date ?? existing.effective_date,
      clubbing_creation_window_days:
        req.body.clubbing_creation_window_days ?? existing.clubbing_creation_window_days,
      clubbing_need_by_window_days:
        req.body.clubbing_need_by_window_days ?? existing.clubbing_need_by_window_days,
      po_consolidation_window_hours:
        req.body.po_consolidation_window_hours ?? existing.po_consolidation_window_hours,
      active_history_lookback_days:
        req.body.active_history_lookback_days ?? existing.active_history_lookback_days,
      psl_lookback_days: req.body.psl_lookback_days ?? existing.psl_lookback_days,
      psl_recency_high_days: req.body.psl_recency_high_days ?? existing.psl_recency_high_days,
      psl_recency_med_days: req.body.psl_recency_med_days ?? existing.psl_recency_med_days,
      rules: req.body.rules ?? existing.rules,
      plain_language_diff: req.body.plain_language_diff ?? []
    });

    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid policy rule schema',
        details: parsed.error.flatten()
      });
      return;
    }

    const draft = parsed.data;
    draft.rules = [...draft.rules]
      .sort((a, b) => a.priority_order - b.priority_order)
      .map((r, idx) => ({ ...r, priority_order: idx + 1 }));

    const currentActive = loadAllPolicies(db).find((p) => p.status === 'ACTIVE');
    const diff = currentActive ? computePolicyDiff(currentActive, draft) : null;

    db.prepare(
      `UPDATE policies
       SET version = ?, title = ?, effective_date = ?, summary_diff = ?,
           clubbing_creation_window_days = ?, clubbing_need_by_window_days = ?,
           po_consolidation_window_hours = ?, active_history_lookback_days = ?,
           psl_lookback_days = ?, psl_recency_high_days = ?, psl_recency_med_days = ?
       WHERE policy_id = ?`
    ).run(
      draft.new_version.trim().replace(/^v/i, ''),
      draft.title,
      draft.effective_date,
      JSON.stringify(diff ? diff.plain_language_summary : draft.plain_language_diff),
      draft.clubbing_creation_window_days,
      draft.clubbing_need_by_window_days,
      draft.po_consolidation_window_hours,
      draft.active_history_lookback_days,
      draft.psl_lookback_days,
      draft.psl_recency_high_days,
      draft.psl_recency_med_days,
      policyId
    );

    db.prepare('DELETE FROM policy_rules WHERE policy_id = ?').run(policyId);
    const insertRule = db.prepare(
      `INSERT INTO policy_rules
       (policy_id, clause_number, priority_order, rule_name, conditions_json, outcome, route,
        supplier_strategy, supplier_suggestion_count, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of draft.rules) {
      insertRule.run(
        policyId,
        r.clause_number,
        r.priority_order,
        r.rule_name,
        JSON.stringify(r.conditions),
        r.outcome,
        r.route,
        r.supplier_strategy,
        r.supplier_suggestion_count,
        r.notes || null
      );
    }

    const updated = loadAllPolicies(db).find((p) => p.policy_id === policyId)!;
    res.json({ draft_policy: updated, diff });
  });

  /**
   * POST /api/policy/:id/activate (and alias POST /api/policy/activate with body { policy_id })
   * Approves and activates the policy version without any code change or restart.
   */
  const handleActivate = (policyId: number, body: unknown, res: import('express').Response) => {
    const parsed = ActivatePolicySchema.safeParse(body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid activation payload' });
      return;
    }

    const all = loadAllPolicies(db);
    const target = all.find((p) => p.policy_id === policyId);
    if (!target) {
      res.status(404).json({ error: `Policy #${policyId} not found.` });
      return;
    }
    if (target.rules.length === 0) {
      res.status(400).json({ error: 'Cannot activate a policy with zero rules.' });
      return;
    }

    const nowIso = new Date().toISOString();
    const { approved_by } = parsed.data;

    db.prepare("UPDATE policies SET status = 'SUPERSEDED' WHERE status = 'ACTIVE' AND policy_id != ?").run(
      policyId
    );
    db.prepare(
      "UPDATE policies SET status = 'ACTIVE', approved_by = ?, approved_at = ? WHERE policy_id = ?"
    ).run(approved_by, nowIso, policyId);

    db.prepare(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
       VALUES ('POLICY', ?, 'ACTIVATED', ?, ?, ?)`
    ).run(
      `v${target.version}`,
      approved_by,
      nowIso,
      JSON.stringify({
        policy_id: policyId,
        effective_date: target.effective_date,
        rule_count: target.rules.length
      })
    );

    const activated = loadAllPolicies(db).find((p) => p.policy_id === policyId)!;
    res.json({
      message: `Policy v${activated.version} is now ACTIVE from ${activated.effective_date}.`,
      active_policy: activated
    });
  };

  router.post('/policy/:id/activate', (req, res) => {
    handleActivate(Number(req.params.id), req.body, res);
  });

  router.post('/policy/activate', (req, res) => {
    const policyId = Number(req.body?.policy_id);
    if (!policyId) {
      res.status(400).json({ error: 'policy_id is required' });
      return;
    }
    handleActivate(policyId, req.body, res);
  });

  /**
   * DELETE /api/policy/:id
   * Rejects/discards a DRAFT policy.
   */
  router.delete('/policy/:id', (req, res) => {
    const policyId = Number(req.params.id);
    const existing = loadAllPolicies(db).find((p) => p.policy_id === policyId);
    if (!existing) {
      res.status(404).json({ error: `Policy #${policyId} not found.` });
      return;
    }
    if (existing.status !== 'DRAFT') {
      res.status(400).json({ error: 'Only DRAFT policies can be rejected/deleted.' });
      return;
    }
    db.prepare('DELETE FROM policies WHERE policy_id = ?').run(policyId);
    res.json({ deleted: true, policy_id: policyId });
  });

  return router;
}
