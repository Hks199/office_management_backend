const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function businessDate(date = new Date()): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid date');
  const parts = businessDateFormatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new RangeError('Business date cannot be formatted');
    return value;
  };
  return `${get('year')}-${get('month')}-${get('day')}`;
}
