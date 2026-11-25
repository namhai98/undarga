/**
 * Wall-clock time in a named time zone, without a date library.
 *
 * A `datetime-local` input yields "2026-11-02T09:00" with no zone. Read with
 * `new Date()` it becomes 09:00 on THIS DEVICE — wrong for a manager in
 * another city recording time off at a branch. These helpers read and write it
 * in the business's own zone instead.
 */

/** Milliseconds the zone is ahead of UTC at `instant`. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** `"2026-11-02T09:00"` as 09:00 in `timeZone` → an ISO instant. */
export function wallToIso(local: string, timeZone: string): string {
  const [date, time = '00:00'] = local.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  // Twice: the offset at the guess can differ from the offset at the answer
  // across a daylight-saving change.
  let instant = guess - offsetAt(guess, timeZone);
  instant = guess - offsetAt(instant, timeZone);
  return new Date(instant).toISOString();
}

/** An ISO instant → `"2026-11-02T09:00"` as seen in `timeZone`, for a `datetime-local` value. */
export function isoToWall(iso: string, timeZone: string): string {
  const instant = Date.parse(iso);
  return new Date(instant + offsetAt(instant, timeZone)).toISOString().slice(0, 16);
}

/** An ISO instant, written for people, in `timeZone`. */
export function formatInZone(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
}
