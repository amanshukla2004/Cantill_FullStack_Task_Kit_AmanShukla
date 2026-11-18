import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot } from '../db.js';
import { extractContractFromPdfBuffer } from '../services/pdf-extractor.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const ContractLineInputSchema = z.object({
  item_code: z.string().min(1),
  description: z.string().min(1),
  uom: z.string().min(1),
  rate: z.number().positive()
});

const CreateContractSchema = z
  .object({
    contract_id: z.string().min(3),
    supplier_id: z.string().min(2),
    supplier_name: z.string().min(1).optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    value_cap: z.number().positive(),
    initial_consumed_value: z.number().min(0).default(0),
    source: z.enum(['REGISTER_CSV', 'SIGNED_PDF', 'MANUAL']).default('SIGNED_PDF'),
    actor: z.string().default('Buyer'),
    lines: z.array(ContractLineInputSchema).min(1)
  })
  .refine((d) => d.end_date >= d.start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date']
  })
  .refine((d) => d.initial_consumed_value <= d.value_cap, {
    message: 'initial_consumed_value cannot exceed value_cap',
    path: ['initial_consumed_value']
  });

export function createContractsRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * GET /api/contracts
   */
  router.get('/contracts', (req, res) => {
    const asOfDate =
      typeof req.query.as_of_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of_date)
        ? req.query.as_of_date
        : new Date().toISOString().slice(0, 10);

    const snap = loadMasterDataSnapshot(db);
    const contracts = snap.contracts.map((c) => {
      const supplier = snap.suppliers.get(c.supplier_id);
      const lines = snap.contractLines.filter((cl) => cl.contract_id === c.contract_id);
      const remaining = Number((c.value_cap - c.initial_consumed_value).toFixed(2));
      const utilizationPct =
        c.value_cap > 0 ? Number(((c.initial_consumed_value / c.value_cap) * 100).toFixed(1)) : 0;

      let validityStatus: 'ACTIVE' | 'EXPIRED' | 'UPCOMING' | 'BLOCKED_SUPPLIER' = 'ACTIVE';
      if (!supplier || supplier.status !== 'Active') {
        validityStatus = 'BLOCKED_SUPPLIER';
      } else if (asOfDate > c.end_date) {
        validityStatus = 'EXPIRED';
      } else if (asOfDate < c.start_date) {
        validityStatus = 'UPCOMING';
      }

      return {
        ...c,
        supplier_status: supplier?.status ?? 'Unknown',
        remaining_value: remaining,
        utilization_pct: utilizationPct,
        validity_status: validityStatus,
        lines
      };
    });

    res.json({ as_of_date: asOfDate, contracts });
  });

  /**
   * POST /api/contracts/upload-pdf
   * Extracts contract metadata + Schedule A lines from an uploaded PDF for buyer verification.
   */
  router.post('/contracts/upload-pdf', upload.any(), async (req, res) => {
    try {
      const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
      const uploadedFile = files[0];
      if (!uploadedFile) {
        res.status(400).json({ error: 'Please upload a PDF file.' });
        return;
      }

      // Check PDF magic bytes (%PDF-) before attempting extraction
      const magic = uploadedFile.buffer.subarray(0, 5).toString('ascii');
      if (magic !== '%PDF-') {
        res.status(400).json({
          error: 'Invalid PDF file: uploaded file does not have a valid %PDF- header.'
        });
        return;
      }

      const extracted = await extractContractFromPdfBuffer(uploadedFile.buffer);
      res.json({
        filename: uploadedFile.originalname,
        extracted: {
          contract_id: extracted.contract_id,
          supplier_id: extracted.supplier_id,
          supplier_name: extracted.supplier_name,
          start_date: extracted.start_date,
          end_date: extracted.end_date,
          value_cap: extracted.value_cap,
          initial_consumed_value: 0,
          source: 'SIGNED_PDF',
          lines: extracted.lines,
          extraction_method: extracted.extraction_method
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PDF extraction failed';
      const isBadPdf = /invalid\s+pdf|corrupt|xref|trailer|password/i.test(message);
      res.status(isBadPdf ? 400 : 500).json({ error: message });
    }
  });

  /**
   * POST /api/contracts
   * Commits a PDF-extracted or manually entered contract into SQLite.
   */
  router.post('/contracts', (req, res) => {
    const parsed = CreateContractSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid contract payload', details: parsed.error.flatten() });
      return;
    }

    const data = parsed.data;
    const snap = loadMasterDataSnapshot(db);
    const supplier = snap.suppliers.get(data.supplier_id.toUpperCase());
    if (!supplier) {
      res.status(400).json({ error: `Supplier '${data.supplier_id}' does not exist in supplier master.` });
      return;
    }

    const seenItems = new Set<string>();
    for (const line of data.lines) {
      const code = line.item_code.trim().toUpperCase();
      if (!snap.items.has(code)) {
        res.status(400).json({ error: `Item '${line.item_code}' does not exist in item master.` });
        return;
      }
      if (seenItems.has(code)) {
        res.status(400).json({
          error: `Duplicate item_code '${code}' in Schedule A lines; each item can appear only once per contract.`
        });
        return;
      }
      seenItems.add(code);
    }

    const contractId = data.contract_id.trim().toUpperCase();
    const supplierName = data.supplier_name?.trim() || supplier.name;

    db.exec('BEGIN');
    try {
      db.prepare(
        `INSERT OR REPLACE INTO contracts
         (contract_id, supplier_id, supplier_name, start_date, end_date, value_cap, initial_consumed_value, current_consumed_value, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        contractId,
        supplier.supplier_id,
        supplierName,
        data.start_date,
        data.end_date,
        data.value_cap,
        data.initial_consumed_value,
        data.initial_consumed_value,
        data.source
      );

      db.prepare('DELETE FROM contract_lines WHERE contract_id = ?').run(contractId);
      const insertLine = db.prepare(
        `INSERT INTO contract_lines (contract_id, item_code, description, uom, rate)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const line of data.lines) {
        insertLine.run(
          contractId,
          line.item_code.trim().toUpperCase(),
          line.description.trim(),
          line.uom.trim().toUpperCase(),
          line.rate
        );
      }

      const nowIso = new Date().toISOString();
      db.prepare(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, timestamp, details_json)
         VALUES ('CONTRACT', ?, 'CREATED_OR_UPDATED', ?, ?, ?)`
      ).run(
        contractId,
        data.actor,
        nowIso,
        JSON.stringify({
          supplier_id: supplier.supplier_id,
          start_date: data.start_date,
          end_date: data.end_date,
          value_cap: data.value_cap,
          line_count: data.lines.length,
          source: data.source
        })
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      const msg = err instanceof Error ? err.message : 'Failed to save contract';
      res.status(500).json({ error: msg });
      return;
    }

    res.status(201).json({
      message: `Contract ${contractId} saved successfully.`,
      contract_id: contractId,
      line_count: data.lines.length
    });
  });

  return router;
}
