import fs from 'node:fs';
import { z } from 'zod';
import { extractText } from 'unpdf';
import { groqClient } from './groq-client.js';

const GroqContractFallbackSchema = z.object({
  contract_id: z.string().min(1),
  supplier_id: z.string().min(1),
  supplier_name: z.string().default(''),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value_cap: z.number().positive(),
  lines: z.array(
    z.object({
      item_code: z.string().min(1),
      description: z.string().min(1),
      uom: z.string().min(1),
      rate: z.number().positive()
    })
  )
});

export interface ExtractedContractLine {
  item_code: string;
  description: string;
  uom: string;
  rate: number;
}

export interface ExtractedContractData {
  contract_id: string;
  supplier_id: string;
  supplier_name: string;
  start_date: string;
  end_date: string;
  value_cap: number;
  lines: ExtractedContractLine[];
  raw_text: string;
  extraction_method: 'DETERMINISTIC_PDF' | 'GROQ_FALLBACK';
}

/**
 * Parses Indian & standard comma-formatted currency numbers (e.g. "20,00,000" -> 2000000, "3,537.76" -> 3537.76)
 */
export function parseInrNumber(raw: string): number {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

export async function extractPdfRawText(buffer: Buffer): Promise<string> {
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : String(text || '');
}

export function parseContractTextDeterministic(rawText: string): ExtractedContractData {
  const normalized = rawText.replace(/\r/g, '\n');

  // Contract No. RC-2026-031
  const contractIdMatch = normalized.match(/Contract\s+No\.?\s*([A-Z]{2}-\d{4}-\d{3})/i)
    || normalized.match(/\b(RC-\d{4}-\d{3})\b/i);
  const contract_id = contractIdMatch ? contractIdMatch[1].toUpperCase() : '';

  // Supplier name & Supplier ID: "... and Pneumatic Point, Pune (Supplier ID S021)"
  const supplierMatch = normalized.match(
    /and\s+([^,\n(]+?)(?:,\s*[^(\n]+)?\s*\(Supplier\s+ID\s+([A-Z]\d{3})\)/i
  );
  const supplier_name = supplierMatch ? supplierMatch[1].trim() : '';
  const supplier_id = supplierMatch
    ? supplierMatch[2].toUpperCase()
    : (normalized.match(/Supplier\s+ID\s+([A-Z]\d{3})/i)?.[1]?.toUpperCase() ?? '');

  // Term: "valid from 2026-11-15 to 2027-11-14"
  const termMatch = normalized.match(
    /valid\s+from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i
  );
  const start_date = termMatch ? termMatch[1] : '';
  const end_date = termMatch ? termMatch[2] : '';

  // Value ceiling: "not exceed INR 20,00,000"
  const capMatch = normalized.match(
    /(?:not\s+exceed|ceiling[^0-9]*?)(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d+)?)/i
  );
  const value_cap = capMatch ? parseInrNumber(capMatch[1]) : 0;

  // Schedule A table rows:
  // Works whether pdf text preserves newlines or collapses spaces on a line
  const lines: ExtractedContractLine[] = [];
  const scheduleIdx = normalized.search(/Schedule\s+A/i);
  const scheduleText = scheduleIdx >= 0 ? normalized.slice(scheduleIdx) : normalized;

  // Match pattern: <ITM-1036> <description> <UOM> <rate>
  const rowRegex =
    /(ITM-\d{4})\s+(.+?)\s+(NOS|KG|LTR|MTR|PAIR|SET|CYL|ROL|BRL|BKT|REAM|MON|QTR|JOB)\s+([\d,]+\.\d{2}|[\d,]+)/g;

  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(scheduleText)) !== null) {
    const item_code = m[1].toUpperCase();
    const description = m[2].replace(/\s+/g, ' ').trim();
    const uom = m[3].toUpperCase();
    const rate = parseInrNumber(m[4]);
    if (!lines.some((l) => l.item_code === item_code)) {
      lines.push({ item_code, description, uom, rate });
    }
  }

  return {
    contract_id,
    supplier_id,
    supplier_name,
    start_date,
    end_date,
    value_cap,
    lines,
    raw_text: rawText,
    extraction_method: 'DETERMINISTIC_PDF'
  };
}

export async function extractContractFromPdfBuffer(
  buffer: Buffer
): Promise<ExtractedContractData> {
  const rawText = await extractPdfRawText(buffer);
  const det = parseContractTextDeterministic(rawText);

  // If deterministic parser missed key fields on an unusual PDF layout, try Groq fallback
  const incomplete =
    !det.contract_id || !det.supplier_id || !det.start_date || !det.end_date || det.lines.length === 0;

  if (incomplete && groqClient.isConfigured() && rawText.trim().length > 20) {
    const aiRes = await groqClient.completeJson(
      `Extract rate contract details from this procurement contract PDF text.
Return ONLY valid JSON:
{ "contract_id": "RC-...", "supplier_id": "S...", "supplier_name": "...", "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "value_cap": number, "lines": [{ "item_code": "ITM-...", "description": "...", "uom": "...", "rate": number }] }`,
      rawText.slice(0, 12000),
      GroqContractFallbackSchema
    );
    if (aiRes.ok && aiRes.data) {
      return {
        ...aiRes.data,
        raw_text: rawText,
        extraction_method: 'GROQ_FALLBACK'
      };
    }
  }

  return det;
}

export async function extractContractFromPdfFile(
  filePath: string
): Promise<ExtractedContractData> {
  const buffer = fs.readFileSync(filePath);
  return extractContractFromPdfBuffer(buffer);
}
