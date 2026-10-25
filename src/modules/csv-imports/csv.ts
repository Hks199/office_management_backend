import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { AppError } from '../../shared/errors/app-error.js';
export async function* csvRecords(source: Readable, expectedSize: number): AsyncGenerator<string[]> {
  const decoder = new TextDecoder('utf-8', { fatal: true }); let bytes = 0;
  const decoded = Readable.from((async function* () {
    const iterator = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    for (;;) {
      // Time only waiting for an upstream chunk, not parser/DB backpressure between reads.
      const timeout = setTimeout(() => source.destroy(new AppError(503, 'CSV_STREAM_TIMEOUT', 'CSV storage stream stopped responding')), 30000);
      let item: IteratorResult<Uint8Array, unknown>;
      try { item = await iterator.next(); } finally { clearTimeout(timeout); }
      if (item.done) break;
      const chunk = item.value;
      bytes += chunk.byteLength;
      if (bytes > expectedSize || bytes > 20971520) throw new AppError(400, 'CSV_SIZE_LIMIT', 'CSV exceeds its declared size or byte limit');
      const text = decoder.decode(chunk, { stream: true });
      if (text.includes('\0')) throw new AppError(400, 'INVALID_CSV_FORMAT', 'CSV must be UTF-8 text without NUL bytes'); yield text;
    }
    yield decoder.decode();
    if (bytes !== expectedSize) throw new AppError(400, 'CSV_SIZE_MISMATCH', 'CSV stream is incomplete');
  })());
  const parser = parse({ bom: true, columns: false, skip_empty_lines: true, max_record_size: 16384, trim: true });
  // Attach rejection handling immediately so upstream/parser errors cannot become unhandled promises.
  let failure: unknown; const running = pipeline(decoded, parser).catch((error: unknown) => { failure = error; });
  try {
    let count = 0;
    for await (const raw of parser as AsyncIterable<unknown>) {
      if (!Array.isArray(raw) || raw.some((field: unknown) => typeof field !== 'string' || field.length > 2000) || raw.length > 16 || ++count > 50001) throw new AppError(400, 'CSV_LIMIT', 'CSV row, column or cell limit exceeded');
      yield raw as string[];
    }
    await running; if (failure) throw failure instanceof Error ? failure : new Error('CSV stream failed');
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_CSV_FORMAT', 'CSV encoding, quoting or record structure is invalid');
  } finally { source.destroy(); decoded.destroy(); parser.destroy(); await running; }
}
export function csvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  const firstMeaningful = Array.from(text).find((character) => character.charCodeAt(0) > 32 && character.trim() !== '');
  const safe = (firstMeaningful !== undefined && '=+-@'.includes(firstMeaningful)) || /^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
