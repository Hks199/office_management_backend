// All public quantities use two fractional digits. Product is rounded half-up to INR paise.
export function hundredths(value: string): bigint { const [whole = '0', fraction = ''] = value.split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); }
export function decimalString(value: bigint): string { return `${String(value / 100n)}.${String(value % 100n).padStart(2, '0')}`; }
export function projectValue(capacity: string, rate: string): string { return decimalString((hundredths(capacity) * hundredths(rate) + 50n) / 100n); }
