import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { csvRecords, csvCell } from '../../src/modules/csv-imports/csv.js';
import { projectValue } from '../../src/modules/leads/decimal.js';
import { leadCreateSchema, normalizePhone } from '../../src/modules/leads/commercial.validator.js';
const read = async (body: string | Buffer, size = Buffer.byteLength(body)) => {
  const rows: string[][] = []; for await (const row of csvRecords(Readable.from([Buffer.from(body)]), size)) rows.push(row); return rows;
};
describe('bounded CSV parsing', () => {
  it('streams UTF-8 BOM, quoted commas/newlines and escaped quotes', async () => {
    expect(await read('\ufeffName,Address\r\n"A, B","One\nTwo ""Street"""\r\n')).toEqual([['Name', 'Address'], ['A, B', 'One\nTwo "Street"']]);
  });
  it('rejects invalid encoding, binary, malformed quoting, oversized cells/records and wrong sizes', async () => {
    for (const body of [Buffer.from([255, 254, 253]), Buffer.from('A,B\nx,\0'), Buffer.from('A,B\n"unclosed,y'), Buffer.from(`A,B\n${'x'.repeat(2001)},y`),
      Buffer.from(`A,B\n${'x'.repeat(17000)},y`), Buffer.from('a,b\nc,d,e'), Buffer.from(Array.from({ length: 17 }, () => 'header').join(','))]) await expect(read(body)).rejects.toBeDefined();
    await expect(read('a,b\nc,d', 1)).rejects.toMatchObject({ code: 'CSV_SIZE_LIMIT' });
    await expect(read('a,b', 20)).rejects.toBeDefined();
  });
  it('rejects more than 50000 customer rows without buffering the input', async () => {
    const chunks = (function* () { yield Buffer.from('a,b\n'); for (let i = 0; i < 50001; i++) yield Buffer.from('x,y\n'); })();
    const source = Readable.from(chunks); let seen = 0;
    await expect((async () => { for await (const row of csvRecords(source, 4 * 50002)) { if (!row.length) throw new Error('Unexpected empty row'); seen++; } })()).rejects.toMatchObject({ code: 'CSV_LIMIT' });
    expect(seen).toBe(50001);
  }, 15000);
  it('neutralizes spreadsheet formulas and quotes every CSV cell', () => {
    for (const value of ['=1+1', '+919876543210', '-cmd', '@SUM(A1)', '  =HYPERLINK("evil")', '\tbad', '\rtest', '\nline']) expect(csvCell(value).startsWith('"\'')).toBe(true);
    expect(csvCell('normal,"quoted"')).toBe('"normal,""quoted"""'); expect(csvCell(null)).toBe('""');
  });
  it('bounds stalled upstream reads without treating processing backpressure as a timeout', async () => {
    vi.useFakeTimers();
    const source = new Readable({ read() { /* Simulate a storage stream that never produces bytes. */ } });
    try {
      const pending = (async () => { for await (const row of csvRecords(source, 10)) if (!row.length) throw new Error('Unexpected row'); })();
      const rejected = expect(pending).rejects.toMatchObject({ code: 'CSV_STREAM_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30001); await rejected;
    } finally { source.destroy(); vi.useRealTimers(); }
  });
});
it('uses exact fixed decimal multiplication and half-up INR rounding', () => {
  expect(projectValue('5.00', '55000.00')).toBe('275000.00'); expect(projectValue('0.10', '0.10')).toBe('0.01');
  expect(projectValue('0.01', '0.50')).toBe('0.01'); expect(projectValue('0', '99999999.99')).toBe('0.00');
  expect(projectValue('99999999.99', '99999999.99')).toBe('9999999998000000.00');
});
it('normalizes Indian local or international E.164 phones and rejects numeric/computed lead amounts', () => {
  expect(normalizePhone('98765 43210')).toBe('+919876543210'); expect(normalizePhone('+1 (212) 555-0123')).toBe('+12125550123');
  expect(leadCreateSchema.validate({ estimatedProjectValue: '100' }).error).toBeDefined();
});
