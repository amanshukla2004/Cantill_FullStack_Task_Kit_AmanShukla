import React, { useEffect, useMemo, useState } from 'react';
import { Download, Award } from 'lucide-react';
import { api, RequirementRecord } from '../api/client';

export const PreferredSuppliers: React.FC = () => {
  const [asOfDate, setAsOfDate] = useState('2026-11-01');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<
    Array<{
      item_code: string;
      description: string;
      category: string;
      item_type: string;
      uom: string;
      standard_price: number;
      preferred_suppliers: RequirementRecord['preferred_supplier_breakdown'];
    }>
  >([]);

  const loadPsl = async (dateVal: string) => {
    setLoading(true);
    try {
      const res = await api.getPreferredSuppliers(dateVal);
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPsl(asOfDate);
  }, [asOfDate]);

  const categories = useMemo(
    () => Array.from(new Set(items.map((i) => i.category))).sort(),
    [items]
  );

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (categoryFilter && it.category !== categoryFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !`${it.item_code} ${it.description} ${it.category}`.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [items, search, categoryFilter]);

  return (
    <div>
      <div className="alert alert-info" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <Award size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
          <strong>5-Factor Composite Ranking (Policy Section 6):</strong> Contract History (25%) + PO Volume (25%) + Recency (20%) + Quality (15%) + On-Time Delivery (15%). Blocked & Inactive suppliers strictly excluded.
        </div>
        <a
          href={`/api/preferred-suppliers?as_of_date=${asOfDate}&format=csv`}
          className="btn btn-emerald btn-sm"
          style={{ textDecoration: 'none' }}
        >
          <Download size={14} /> Export Top-3 PSL CSV ({asOfDate})
        </a>
      </div>

      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ width: 240 }}
              placeholder="Filter by item code or name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="select"
              style={{ width: 200 }}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">All Categories ({categories.length})</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ color: 'var(--text-subtle)' }}>Calculate as of date:</span>
            <input
              type="date"
              className="input"
              style={{ width: 155 }}
              value={asOfDate}
              onChange={(e) => setAsOfDate(e.target.value)}
            />
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Ranked Preferred Suppliers (Top 3 + Score Breakdown)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.item_code}>
                  <td style={{ minWidth: 220 }}>
                    <div className="mono" style={{ fontWeight: 700 }}>{it.item_code}</div>
                    <div style={{ fontWeight: 500 }}>{it.description}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-subtle)' }}>
                      {it.item_type} · {it.uom} · Std ₹{it.standard_price.toLocaleString('en-IN')}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <span className="badge badge-neutral">{it.category}</span>
                  </td>
                  <td>
                    {it.preferred_suppliers.length === 0 ? (
                      <span style={{ fontSize: 12.5, color: 'var(--text-subtle)' }}>
                        No eligible Active supplier in 548-day window (uses Clause 6.4 Category Fallback for sourcing)
                      </span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {it.preferred_suppliers.slice(0, 3).map((s) => (
                          <div
                            key={s.supplier_id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 8,
                              padding: '7px 10px',
                              border: '1px solid var(--border)',
                              borderRadius: 7,
                              background: s.rank === 1 ? 'var(--emerald-soft)' : '#fff'
                            }}
                          >
                            <div>
                              <strong style={{ marginRight: 6 }}>#{s.rank}</strong>
                              <span className="mono" style={{ fontWeight: 600 }}>{s.supplier_id}</span>{' '}
                              {s.supplier_name}
                              <span style={{ marginLeft: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
                                Ref <span className="mono">₹{s.reference_price.toFixed(2)}</span> ({s.reference_source})
                              </span>
                            </div>
                            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                              <strong>Score {s.composite_score.toFixed(1)}</strong>{' '}
                              [C:{s.breakdown.contract_score} · V:{s.breakdown.volume_score} ({s.breakdown.po_count_548d} POs) · R:{s.breakdown.recency_score} · Q:{s.breakdown.quality_score} · O:{s.breakdown.on_time_score}]
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && <div style={{ padding: 14, fontSize: 12.5, color: 'var(--text-subtle)' }}>Recalculating rankings...</div>}
      </div>
    </div>
  );
};
