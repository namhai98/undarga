/**
 * Half-open interval arithmetic on epoch milliseconds.
 *
 * The availability engine reduces every source — opening hours, a shift, a
 * break, time off, a closure, a booked appointment — to `[start, end)` pairs of
 * instants and then does set arithmetic. Keeping that arithmetic in one small,
 * total, side-effect-free module is what makes the engine testable line by line
 * and keeps timezone reasoning out of it: by the time an interval reaches here
 * it is already two numbers.
 *
 * Half-open `[start, end)` throughout: two intervals that share only an
 * endpoint (10:00–11:00 and 11:00–12:00) do NOT overlap. That is the correct
 * rule for back-to-back bookings and matches the `tstzrange(..., '[)')` the
 * database exclusion constraint uses.
 */

export interface Interval {
  /** Epoch ms, inclusive. */
  readonly start: number;
  /** Epoch ms, exclusive. */
  readonly end: number;
}

/** A positive-length interval? Zero-length and inverted ranges are not real. */
export function isValid(i: Interval): boolean {
  return i.end > i.start;
}

export function durationMs(i: Interval): number {
  return Math.max(0, i.end - i.start);
}

/**
 * Do two intervals share any instant?
 *
 * The canonical overlap test — `a.start < b.end && b.start < a.end` — never a
 * naive equality check. This is the same predicate the Appointment Engine will
 * reuse when it re-validates a slot under transaction.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Is `inner` wholly within `outer` (endpoints may touch)? */
export function contains(outer: Interval, inner: Interval): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Sort ascending by start, then end. Does not mutate the input. */
export function sortByStart(intervals: readonly Interval[]): Interval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Coalesce a set into the minimal list of disjoint intervals covering the same
 * instants. Overlapping AND touching intervals are merged, so the result is
 * always gap-separated.
 */
export function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = sortByStart(intervals.filter(isValid));
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) out[out.length - 1] = { start: last.start, end: cur.end };
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** Remove every instant in `cuts` from `base`, returning what is left. */
export function subtract(base: Interval, cuts: readonly Interval[]): Interval[] {
  let pieces: Interval[] = isValid(base) ? [{ start: base.start, end: base.end }] : [];
  for (const cut of merge(cuts)) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (!overlaps(piece, cut)) {
        next.push(piece);
        continue;
      }
      if (cut.start > piece.start) next.push({ start: piece.start, end: cut.start });
      if (cut.end < piece.end) next.push({ start: cut.end, end: piece.end });
    }
    pieces = next;
  }
  return pieces;
}

/** `subtract`, lifted over a set of bases. */
export function subtractAll(bases: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  const merged = merge(cuts);
  return merge(bases.flatMap((base) => subtract(base, merged)));
}

/** The intersection of two sets of intervals. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = merge(a);
  const right = merge(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const start = Math.max(l.start, r.start);
    const end = Math.min(l.end, r.end);
    if (end > start) out.push({ start, end });
    if (l.end < r.end) i += 1;
    else j += 1;
  }
  return out;
}

/** Does any interval in the set wholly contain `inner`? */
export function anyContains(set: readonly Interval[], inner: Interval): boolean {
  return merge(set).some((i) => contains(i, inner));
}

/** Does any interval in the set overlap `probe`? */
export function anyOverlaps(set: readonly Interval[], probe: Interval): boolean {
  return set.some((i) => overlaps(i, probe));
}
