import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot } from '../db.js';
import {
  ChatMessage,
  ChatSlots,
  computeMissingSlots,
  createInitialSlots,
  processChatMessage
} from '../services/chat-agent.js';
import { runProcurementPipeline } from '../../engine/pipeline.js';
import { PRLine } from '../../engine/types.js';

const ChatMessageInputSchema = z.object({
  session_id: z.string().optional(),
  message: z.string().min(1, 'Message cannot be empty'),
  reference_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const ConfirmPrSchema = z.object({
  session_id: z.string().min(1),
  requester: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  created_at: z.string().optional()
});

export function createChatRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * POST /api/chat/message
   * Multi-turn Hybrid Groq + Deterministic slot-filling intake.
   */
  router.post('/chat/message', async (req, res) => {
    const parsed = ChatMessageInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chat message payload', details: parsed.error.flatten() });
      return;
    }

    const { message, reference_date } = parsed.data;
    const sessionId = parsed.data.session_id?.trim() || `chat-${crypto.randomUUID().slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    let currentSlots: ChatSlots = createInitialSlots();
    let history: ChatMessage[] = [];

    const existing = db
      .prepare('SELECT * FROM chat_sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;

    if (existing) {
      currentSlots = JSON.parse(String(existing.slots_json)) as ChatSlots;
      history = JSON.parse(String(existing.messages_json)) as ChatMessage[];
    }

    const snap = loadMasterDataSnapshot(db);
    const turn = await processChatMessage({
      sessionId,
      userMessage: message,
      currentSlots,
      history,
      items: snap.items,
      plants: snap.plants,
      referenceDateIso: reference_date
    });

    const updatedHistory: ChatMessage[] = [
      ...history,
      { role: 'user', content: message, timestamp: nowIso },
      { role: 'assistant', content: turn.reply, timestamp: new Date().toISOString() }
    ];

    if (existing) {
      db.prepare(
        `UPDATE chat_sessions
         SET updated_at = ?, slots_json = ?, messages_json = ?, status = ?
         WHERE session_id = ?`
      ).run(
        nowIso,
        JSON.stringify(turn.slots),
        JSON.stringify(updatedHistory),
        turn.ready_to_confirm ? 'READY_TO_CONFIRM' : 'COLLECTING',
        sessionId
      );
    } else {
      db.prepare(
        `INSERT INTO chat_sessions (session_id, created_at, updated_at, slots_json, messages_json, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        nowIso,
        nowIso,
        JSON.stringify(turn.slots),
        JSON.stringify(updatedHistory),
        turn.ready_to_confirm ? 'READY_TO_CONFIRM' : 'COLLECTING'
      );
    }

    res.json({
      ...turn,
      messages: updatedHistory
    });
  });

  /**
   * GET /api/chat/session/:sessionId
   */
  router.get('/chat/session/:sessionId', (req, res) => {
    const row = db
      .prepare('SELECT * FROM chat_sessions WHERE session_id = ?')
      .get(req.params.sessionId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Chat session not found' });
      return;
    }
    const slots = JSON.parse(String(row.slots_json)) as ChatSlots;
    const missing = computeMissingSlots(slots);
    res.json({
      session_id: String(row.session_id),
      status: String(row.status),
      slots,
      missing_slots: missing,
      ready_to_confirm: missing.length === 0,
      messages: JSON.parse(String(row.messages_json))
    });
  });

  /**
   * POST /api/chat/confirm-pr
   * Creates the PR from validated chat slots, runs the active policy engine,
   * and inserts the requirement directly into the Buyer Workspace.
   */
  router.post('/chat/confirm-pr', (req, res) => {
    const parsed = ConfirmPrSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid confirmation payload', details: parsed.error.flatten() });
      return;
    }

    const { session_id, requester, department, created_at } = parsed.data;
    const sessionRow = db
      .prepare('SELECT * FROM chat_sessions WHERE session_id = ?')
      .get(session_id) as Record<string, unknown> | undefined;

    if (!sessionRow) {
      res.status(404).json({ error: `Chat session '${session_id}' not found.` });
      return;
    }

    if (String(sessionRow.status) === 'CONFIRMED') {
      res.status(409).json({
        error: 'This chat session has already been confirmed and created as a PR. Start a new chat request to raise another PR.'
      });
      return;
    }

    const slots = JSON.parse(String(sessionRow.slots_json)) as ChatSlots;
    const missing = computeMissingSlots(slots);
    if (missing.length > 0) {
      res.status(400).json({
        error: `Cannot create PR yet — missing required fields: ${missing.join(', ')}`,
        missing_slots: missing
      });
      return;
    }

    const snap = loadMasterDataSnapshot(db);
    const nowIso = new Date().toISOString();
    const createdTimestamp = created_at || `${nowIso.slice(0, 10)} ${nowIso.slice(11, 16)}`;

    const chatPrCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM pr_lines WHERE source = 'CHAT'").get() as {
        cnt: number;
      }
    ).cnt;
    const prNo = `PR-CHAT-${String(chatPrCount + 1).padStart(4, '0')}`;

    const prLine: PRLine = {
      pr_no: prNo,
      pr_line: 1,
      created_at: createdTimestamp,
      requester: requester || slots.requester || 'Shop-Floor Requester',
      department: department || slots.department || 'Production',
      plant: slots.plant!,
      raw_item_code: slots.resolved_item_code === 'NEW' ? null : slots.resolved_item_code,
      description: slots.item_description || slots.item_query || 'Requested Item',
      quantity: slots.quantity!,
      uom: slots.uom || 'NOS',
      estimated_unit_price: slots.estimated_unit_price,
      need_by_date: slots.need_by_date!,
      urgency: slots.urgency!
    };

    // Persist PR line
    db.prepare(
      `INSERT INTO pr_lines
       (batch_id, pr_no, pr_line, created_at, requester, department, plant,
        raw_item_code, description, quantity, uom, estimated_unit_price, need_by_date, urgency, source)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CHAT')`
    ).run(
      prLine.pr_no,
      prLine.pr_line,
      prLine.created_at,
      prLine.requester,
      prLine.department,
      prLine.plant,
      prLine.raw_item_code,
      prLine.description,
      prLine.quantity,
      prLine.uom,
      prLine.estimated_unit_price,
      prLine.need_by_date,
      prLine.urgency
    );

    // Check if this new chat PR clubs with any existing PENDING_REVIEW chat requirements (anti-splitting Clause 2!)
    const openChatReqs = db
      .prepare(
        "SELECT * FROM requirements WHERE batch_id IS NULL AND status = 'PENDING_REVIEW' ORDER BY id ASC"
      )
      .all() as Array<Record<string, unknown>>;

    const openChatLines: PRLine[] = [];
    const prNoToExistingReq = new Map<string, Record<string, unknown>>();
    for (const reqRow of openChatReqs) {
      const parsedLines = JSON.parse(String(reqRow.lines_json)) as PRLine[];
      for (const pl of parsedLines) {
        openChatLines.push(pl);
        prNoToExistingReq.set(`${pl.pr_no}/${pl.pr_line}`, reqRow);
      }
    }

    // Run deterministic decision engine across open chat PRs + the new PR line
    const pipelineResult = runProcurementPipeline({
      prLines: [...openChatLines, prLine],
      plants: snap.plants,
      items: snap.items,
      suppliers: snap.suppliers,
      contracts: snap.contracts,
      contractLines: snap.contractLines,
      poHistory: snap.poHistory,
      policies: snap.policies
    });

    const decisionRow = pipelineResult.decisions.find(
      (d) => d.pr_no === prLine.pr_no && d.pr_line === prLine.pr_line
    )!;
    const evalItem = pipelineResult.evaluatedRequirements.find((e) =>
      e.requirement.lines.some((l) => l.pr_no === prLine.pr_no && l.pr_line === prLine.pr_line)
    );

    // Did it club into an existing open chat requirement?
    const clubbedAnchorLine = evalItem?.requirement.lines.find(
      (l) => l.pr_no !== prLine.pr_no && prNoToExistingReq.has(`${l.pr_no}/${l.pr_line}`)
    );
    const existingReqRow = clubbedAnchorLine
      ? prNoToExistingReq.get(`${clubbedAnchorLine.pr_no}/${clubbedAnchorLine.pr_line}`)
      : undefined;

    let requirementId: number;
    let groupId: string;
    let clubbedWithExisting = false;

    if (existingReqRow && evalItem) {
      clubbedWithExisting = true;
      requirementId = Number(existingReqRow.id);
      groupId = String(existingReqRow.group_id);
      const updatedPoId =
        decisionRow.decision === 'PO'
          ? (existingReqRow.po_id ? String(existingReqRow.po_id) : `PO-CHAT-${String(chatPrCount + 1).padStart(4, '0')}`)
          : null;

      db.prepare(
        `UPDATE requirements
         SET po_id = ?,
             total_quantity = ?,
             is_emergency = ?,
             decision = ?,
             route = ?,
             supplier_id = ?,
             unit_price = ?,
             group_value_inr = ?,
             suggested_supplier_ids = ?,
             policy_version = ?,
             clause_applied = ?,
             reason = ?,
             reference_doc = ?,
             lines_json = ?
         WHERE id = ?`
      ).run(
        updatedPoId,
        evalItem.requirement.total_quantity,
        evalItem.requirement.is_emergency ? 1 : 0,
        decisionRow.decision,
        decisionRow.route,
        decisionRow.supplier_id || null,
        decisionRow.unit_price || null,
        decisionRow.group_value_inr,
        decisionRow.suggested_supplier_ids || null,
        decisionRow.policy_version,
        evalItem.clause_applied,
        decisionRow.reason,
        evalItem.reference_doc || null,
        JSON.stringify(evalItem.requirement.lines),
        requirementId
      );
    } else {
      groupId = `GRP-CHAT-${String(chatPrCount + 1).padStart(4, '0')}`;
      const reqInsert = db
        .prepare(
          `INSERT INTO requirements
           (batch_id, group_id, po_id, resolved_item_code, plant, first_created_at, first_need_by_date,
            total_quantity, is_emergency, decision, route, supplier_id, unit_price, group_value_inr,
            suggested_supplier_ids, policy_version, clause_applied, reason, reference_doc, lines_json, status)
           VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          groupId,
          evalItem?.po_id ? `PO-CHAT-${String(chatPrCount + 1).padStart(4, '0')}` : null,
          decisionRow.resolved_item_code,
          prLine.plant,
          prLine.created_at,
          prLine.need_by_date,
          prLine.quantity,
          prLine.urgency === 'Emergency' ? 1 : 0,
          decisionRow.decision,
          decisionRow.route,
          decisionRow.supplier_id || null,
          decisionRow.unit_price || null,
          decisionRow.group_value_inr,
          decisionRow.suggested_supplier_ids || null,
          decisionRow.policy_version,
          evalItem?.clause_applied || 'ANOMALY',
          decisionRow.reason,
          evalItem?.reference_doc || null,
          JSON.stringify([prLine]),
          decisionRow.decision === 'NOT_PROCESSED' ? 'FLAGGED_EXCEPTION' : 'PENDING_REVIEW'
        );
      requirementId = Number(reqInsert.lastInsertRowid);
    }

    db.prepare("UPDATE chat_sessions SET status = 'CONFIRMED', updated_at = ? WHERE session_id = ?").run(
      nowIso,
      session_id
    );

    db.prepare(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
       VALUES ('PR_CHAT', ?, 'CREATED', ?, ?, ?)`
    ).run(
      prNo,
      prLine.requester,
      nowIso,
      JSON.stringify({
        requirement_id: requirementId,
        group_id: groupId,
        clubbed_with_existing: clubbedWithExisting,
        resolved_item_code: decisionRow.resolved_item_code,
        quantity: prLine.quantity,
        plant: prLine.plant,
        decision: decisionRow.decision,
        route: decisionRow.route,
        group_value_inr: decisionRow.group_value_inr
      })
    );

    res.status(201).json({
      pr_no: prNo,
      requirement_id: requirementId,
      group_id: groupId,
      clubbed_with_existing: clubbedWithExisting,
      decision: decisionRow
    });
  });

  return router;
}
