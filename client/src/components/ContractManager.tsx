import React, { useEffect, useRef, useState } from 'react';
import { Upload, Plus, FileText, Trash2, CheckCircle2 } from 'lucide-react';
import { api, ContractDto, formatInr, MasterDataResponse } from '../api/client';

interface Props {
  masterData: MasterDataResponse | null;
  onDataChanged: () => void;
}

interface EditableLine {
  item_code: string;
  description: string;
  uom: string;
  rate: number;
}

export const ContractManager: React.FC<Props> = ({ masterData, onDataChanged }) => {
  const [contracts, setContracts] = useState<ContractDto[]>([]);
  const [asOfDate, setAsOfDate] = useState('2026-11-18');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state for PDF-extracted or manual contract
  const [contractId, setContractId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [supplierName, setSupplierName] = useState('');
  const [startDate, setStartDate] = useState('2026-11-15');
  const [endDate, setEndDate] = useState('2027-11-14');
  const [valueCap, setValueCap] = useState('2000000');
  const [source, setSource] = useState<'SIGNED_PDF' | 'MANUAL'>('SIGNED_PDF');
  const [lines, setLines] = useState<EditableLine[]>([
    { item_code: 'ITM-1036', description: 'Pneumatic cylinder 50x100', uom: 'NOS', rate: 3500 }
  ]);

  const pdfRef = useRef<HTMLInputElement | null>(null);

  const loadContracts = async (dateVal = asOfDate) => {
    try {
      const res = await api.getContracts(dateVal);
      setContracts(res.contracts);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load contracts');
    }
  };

  useEffect(() => {
    loadContracts(asOfDate);
  }, [asOfDate]);

  const handlePdfUpload = async (file: File) => {
    setExtracting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.uploadContractPdf(file);
      const ext = res.extracted;
      setContractId(ext.contract_id);
      setSupplierId(ext.supplier_id);
      setSupplierName(ext.supplier_name);
      setStartDate(ext.start_date || '2026-11-15');
      setEndDate(ext.end_date || '2027-11-14');
      setValueCap(String(ext.value_cap || ''));
      setSource('SIGNED_PDF');
      setLines(
        ext.lines.length > 0
          ? ext.lines
          : [{ item_code: '', description: '', uom: 'NOS', rate: 0 }]
      );
      setModalOpen(true);
      setSuccess(
        `Extracted ${ext.contract_id || file.name} (${ext.lines.length} Schedule A items) via ${ext.extraction_method}. Verify fields and save.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract contract PDF');
    } finally {
      setExtracting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveContract({
        contract_id: contractId,
        supplier_id: supplierId,
        supplier_name: supplierName || undefined,
        start_date: startDate,
        end_date: endDate,
        value_cap: Number(valueCap),
        initial_consumed_value: 0,
        source,
        lines: lines.map((l) => ({ ...l, rate: Number(l.rate) }))
      });
      setModalOpen(false);
      setSuccess(res.message);
      await loadContracts(asOfDate);
      onDataChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save contract');
    } finally {
      setSaving(false);
    }
  };

  const openBlankModal = () => {
    setContractId('RC-2026-');
    setSupplierId('');
    setSupplierName('');
    setStartDate('2026-11-18');
    setEndDate('2027-11-17');
    setValueCap('1500000');
    setSource('MANUAL');
    setLines([{ item_code: '', description: '', uom: 'NOS', rate: 0 }]);
    setModalOpen(true);
  };

  const activeSuppliers = (masterData?.suppliers || []).filter((s) => s.status === 'Active');

  return (
    <div>
      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap' }}>
          <div>
            <h2>Rate Contract Register & Signed PDF Contracts ({contracts.length})</h2>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginTop: 2 }}>
              Includes 10 register contracts + signed post-register PDFs (Clause 4.4)
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <span style={{ color: 'var(--text-subtle)' }}>Validity as of:</span>
              <input
                type="date"
                className="input"
                style={{ width: 150 }}
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
              />
            </div>
            <input
              ref={pdfRef}
              type="file"
              accept=".pdf,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePdfUpload(f);
                e.target.value = '';
              }}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={() => pdfRef.current?.click()}
              disabled={extracting}
            >
              <Upload size={14} /> {extracting ? 'Extracting PDF...' : 'Upload Signed PDF Contract'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={openBlankModal}>
              <Plus size={14} /> Add Manually
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Supplier</th>
                <th>Term</th>
                <th>Ceiling Utilization</th>
                <th>Status</th>
                <th>Source</th>
                <th>Items</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => {
                const isExpanded = expandedId === c.contract_id;
                const fillClass =
                  c.utilization_pct >= 90
                    ? 'progress-fill danger'
                    : c.utilization_pct >= 70
                      ? 'progress-fill warn'
                      : 'progress-fill';
                return (
                  <React.Fragment key={c.contract_id}>
                    <tr
                      className="clickable"
                      onClick={() => setExpandedId(isExpanded ? null : c.contract_id)}
                    >
                      <td className="mono" style={{ fontWeight: 700 }}>{c.contract_id}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.supplier_name}</div>
                        <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-subtle)' }}>
                          {c.supplier_id} ({c.supplier_status})
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {c.start_date} → {c.end_date}
                      </td>
                      <td style={{ minWidth: 190 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                          <span>{formatInr(c.initial_consumed_value)} / {formatInr(c.value_cap)}</span>
                          <strong>{c.utilization_pct}%</strong>
                        </div>
                        <div className="progress-track">
                          <div className={fillClass} style={{ width: `${Math.min(100, c.utilization_pct)}%` }} />
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 3 }}>
                          Room left: {formatInr(c.remaining_value)}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            c.validity_status === 'ACTIVE'
                              ? 'badge-po'
                              : c.validity_status === 'BLOCKED_SUPPLIER'
                                ? 'badge-error'
                                : c.validity_status === 'UPCOMING'
                                  ? 'badge-sourcing'
                                  : 'badge-neutral'
                          }`}
                        >
                          {c.validity_status.replace('_', ' ')}
                        </span>
                      </td>
                      <td>
                        <span className="badge badge-neutral">
                          <FileText size={11} /> {c.source.replace('_', ' ')}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{c.lines.length} items</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} style={{ background: '#f8fafc', padding: '12px 20px' }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-subtle)', marginBottom: 6 }}>
                            SCHEDULE A — FIXED CONTRACT RATES ({c.contract_id})
                          </div>
                          <table>
                            <thead>
                              <tr>
                                <th>Item Code</th>
                                <th>Description</th>
                                <th>UoM</th>
                                <th>Fixed Rate (INR)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {c.lines.map((l) => (
                                <tr key={l.item_code}>
                                  <td className="mono">{l.item_code}</td>
                                  <td>{l.description}</td>
                                  <td>{l.uom}</td>
                                  <td className="mono" style={{ fontWeight: 600 }}>₹{l.rate.toFixed(2)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Verify Contract Modal */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal-card" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h2>{source === 'SIGNED_PDF' ? 'Verify Extracted PDF Contract' : 'Add Manual Rate Contract'}</h2>
              <button className="btn btn-secondary btn-sm" onClick={() => setModalOpen(false)}>
                Close
              </button>
            </div>
            <form className="card-body" onSubmit={handleSave}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Contract ID *</label>
                  <input
                    className="input mono"
                    required
                    value={contractId}
                    onChange={(e) => setContractId(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Supplier *</label>
                  <select
                    className="select"
                    required
                    value={supplierId}
                    onChange={(e) => {
                      setSupplierId(e.target.value);
                      const found = activeSuppliers.find((s) => s.supplier_id === e.target.value);
                      if (found) setSupplierName(found.name);
                    }}
                  >
                    <option value="">Select Supplier...</option>
                    {activeSuppliers.map((s) => (
                      <option key={s.supplier_id} value={s.supplier_id}>
                        {s.supplier_id} — {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Start Date *</label>
                  <input
                    type="date"
                    className="input"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>End Date *</label>
                  <input
                    type="date"
                    className="input"
                    required
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>Value Ceiling (INR, excl. GST) *</label>
                  <input
                    type="number"
                    className="input"
                    required
                    min={1}
                    value={valueCap}
                    onChange={(e) => setValueCap(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-subtle)' }}>
                  SCHEDULE A ITEMS & RATES
                </label>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    setLines((prev) => [...prev, { item_code: '', description: '', uom: 'NOS', rate: 0 }])
                  }
                >
                  <Plus size={13} /> Add Line
                </button>
              </div>

              {lines.map((line, idx) => (
                <div
                  key={idx}
                  style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.6fr 0.6fr 0.8fr auto', gap: 6, marginBottom: 8 }}
                >
                  <select
                    className="select"
                    required
                    value={line.item_code}
                    onChange={(e) => {
                      const code = e.target.value;
                      const found = masterData?.items.find((i) => i.item_code === code);
                      setLines((prev) =>
                        prev.map((row, i) =>
                          i === idx
                            ? {
                                ...row,
                                item_code: code,
                                description: found?.description || row.description,
                                uom: found?.uom || row.uom
                              }
                            : row
                        )
                      );
                    }}
                  >
                    <option value="">Item...</option>
                    {(masterData?.items || []).map((it) => (
                      <option key={it.item_code} value={it.item_code}>
                        {it.item_code}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    placeholder="Description"
                    required
                    value={line.description}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, description: e.target.value } : row))
                      )
                    }
                  />
                  <input
                    className="input"
                    placeholder="UoM"
                    required
                    value={line.uom}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, uom: e.target.value } : row))
                      )
                    }
                  />
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    placeholder="Rate"
                    required
                    value={line.rate}
                    onChange={(e) =>
                      setLines((prev) =>
                        prev.map((row, i) => (i === idx ? { ...row, rate: Number(e.target.value) } : row))
                      )
                    }
                  />
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}

              <button
                type="submit"
                className="btn btn-emerald"
                style={{ width: '100%', marginTop: 12 }}
                disabled={saving}
              >
                <CheckCircle2 size={16} /> {saving ? 'Saving Contract...' : 'Save Contract to Register'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
