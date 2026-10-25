import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { csvCell } from '../csv-imports/csv.js';
import { AppError } from '../../shared/errors/app-error.js';
// Stable, scalar metric/value CSV: preserves exact decimal text and nested metric labels.
export function dashboardCsv(value: unknown): { body: Buffer; fingerprint: string } {
  const lines = ['"metric","value"']; let bytes = Buffer.byteLength(lines[0] ?? '') + 2; let cells = 0;
  function visit(item: unknown, path: string): void {
    if (item instanceof Date) { visit(item.toISOString(), path); return; }
    if (item instanceof Types.ObjectId) { visit(item.toHexString(), path); return; }
    if (item instanceof Types.Decimal128) { visit(item.toString(), path); return; }
    if (Array.isArray(item)) { if (!item.length) visit('[]', path); else item.forEach((entry: unknown, index) => { visit(entry, `${path}.${String(index)}`); }); return; }
    if (item && typeof item === 'object') { for (const [key, entry] of Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) visit(entry, path ? `${path}.${key}` : key); return; }
    if (item === undefined) return;
    const text = item === null ? '' : typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? String(item) : '';
    const line = [path, text].map(csvCell).join(','); bytes += Buffer.byteLength(line) + 2;
    if (++cells > 50000 || bytes > 10485760) throw new AppError(422, 'DASHBOARD_EXPORT_LIMIT', 'Narrow dashboard exports to 50000 scalar metrics and 10 MiB'); lines.push(line);
  }
  visit(value, ''); const body = Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'); return { body, fingerprint: createHash('sha256').update(body).digest('hex') };
}
