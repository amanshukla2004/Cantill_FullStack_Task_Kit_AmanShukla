import { Router } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { loadMasterDataSnapshot } from '../db.js';
import { rankPreferredSuppliers } from '../../engine/preferred-suppliers.js';
import { resolvePolicyForDate } from '../../engine/waterfall-evaluator.js';
import { serializePreferredSuppliersCsv } from '../services/csv-utils.js';

export function createSuppliersRouter(db: DatabaseSync): Router {
  const router = Router();

  /**
   * GET /api/preferred-suppliers?as_of_date=2026-11-01&format=json|csv&item_code=ITM-1048&top=3
   */
  router.get('/preferred-suppliers', (req, res) => {
    const asOfDate =
      typeof req.query.as_of_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.as_of_date)
        ? req.query.as_of_date
        : new Date().toISOString().slice(0, 10);
    const format = String(req.query.format || 'json').toLowerCase();
    const filterItem =
      typeof req.query.item_code === 'string' && req.query.item_code.trim()
        ? req.query.item_code.trim().toUpperCase()
        : null;
    const topN = req.query.top ? Math.max(1, Number(req.query.top)) : 3;

    const snap = loadMasterDataSnapshot(db);
    const activePolicy = resolvePolicyForDate(snap.policies, asOfDate);

    const sortedItemCodes = Array.from(snap.items.keys()).sort();
    const targetItemCodes = filterItem
      ? sortedItemCodes.filter((c) => c === filterItem)
      : sortedItemCodes;

    if (format === 'csv') {
      const csvRows: Array<{
        item_code: string;
        rank: number;
        supplier_id: string;
        reference_price: string;
      }> = [];

      for (const itemCode of targetItemCodes) {
        const ranked = rankPreferredSuppliers(
          itemCode,
          asOfDate,
          snap.suppliers,
          snap.poHistory,
          snap.contracts,
          snap.contractLines,
          {
            lookbackDays: activePolicy?.psl_lookback_days ?? 548,
            recencyHighDays: activePolicy?.psl_recency_high_days ?? 90,
            recencyMedDays: activePolicy?.psl_recency_med_days ?? 365
          }
        ).slice(0, topN);

        for (const r of ranked) {
          csvRows.push({
            item_code: itemCode,
            rank: r.rank,
            supplier_id: r.supplier_id,
            reference_price: r.reference_price.toFixed(2)
          });
        }
      }

      const csv = serializePreferredSuppliersCsv(csvRows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="preferred_suppliers_${asOfDate}.csv"`
      );
      res.send(csv);
      return;
    }

    const itemsWithRankings = targetItemCodes.map((itemCode) => {
      const item = snap.items.get(itemCode)!;
      const ranked = rankPreferredSuppliers(
        itemCode,
        asOfDate,
        snap.suppliers,
        snap.poHistory,
        snap.contracts,
        snap.contractLines,
        {
          lookbackDays: activePolicy?.psl_lookback_days ?? 548,
          recencyHighDays: activePolicy?.psl_recency_high_days ?? 90,
          recencyMedDays: activePolicy?.psl_recency_med_days ?? 365
        }
      );
      return {
        item_code: item.item_code,
        description: item.description,
        category: item.category,
        item_type: item.item_type,
        uom: item.uom,
        standard_price: item.standard_price,
        preferred_suppliers: ranked
      };
    });

    res.json({
      as_of_date: asOfDate,
      scoring_weights: {
        contract_history: 0.25,
        order_volume: 0.25,
        recency: 0.2,
        quality_rating: 0.15,
        on_time_delivery: 0.15
      },
      items: itemsWithRankings
    });
  });

  return router;
}
