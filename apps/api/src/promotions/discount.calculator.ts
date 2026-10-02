import type { DiscountType } from '@prisma/client';

/**
 * ===========================================================================
 * WHERE EVERY DISCOUNT IN THIS SYSTEM IS COMPUTED
 * ===========================================================================
 *
 * One pure function, no database, no clock, no injection. That is deliberate:
 * it is the piece a unit test can pin exhaustively, and the piece that must
 * produce the same number for the quote on the till screen and the charge that
 * follows it. Two implementations of "20% off" is how a customer is quoted one
 * price and charged another.
 *
 * ---------------------------------------------------------------------------
 * INTEGER ARITHMETIC, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * Percentages arrive as basis points (15% = 1500) and the maths is BigInt:
 *
 *     discount = subtotal * bps / 10000
 *
 * BigInt division truncates toward zero, which rounds the discount DOWN and
 * therefore rounds the amount the customer pays UP by at most one minor unit.
 * That is the right direction to be wrong in: the company never accidentally
 * gives away more than it advertised, and no total can be pushed below zero by
 * a rounding artefact.
 *
 * `0.15 * total` in IEEE-754 would be one character shorter and would produce a
 * discount that is a tögrög out on some totals and not others — the kind of
 * discrepancy that is indistinguishable from fraud until somebody spends a day
 * on it.
 *
 * ---------------------------------------------------------------------------
 * THE CLAMP IS NOT DEFENSIVE PROGRAMMING
 * ---------------------------------------------------------------------------
 *
 * A fixed 50,000 discount on a 30,000 basket is a completely ordinary thing for
 * an operator to configure. Without the clamp the total goes negative, and a
 * negative total means the system owes the customer money — which flows into
 * the appointment total, the payment amount and the revenue report before
 * anybody notices. `appointment_totals_nonneg` in 001_hardening.sql would
 * eventually refuse it, as a 500 nobody planned.
 */

export interface DiscountRule {
  readonly discountType: DiscountType;
  /** Basis points. Required when the type is PERCENTAGE. */
  readonly discountValueBps: number | null;
  /** Minor units. Required when the type is FIXED_AMOUNT. */
  readonly discountAmountMinor: bigint | null;
  /** Caps a percentage discount. Ignored for fixed amounts. */
  readonly maxDiscountMinor: bigint | null;
}

export interface DiscountResult {
  /** Never negative, never larger than the eligible amount. */
  readonly discountMinor: bigint;
  /** What the customer pays. Never negative. */
  readonly totalMinor: bigint;
  /** Set when the raw discount was reduced, so the UI can explain the number. */
  readonly cappedBy: 'maxDiscount' | 'subtotal' | null;
}

/**
 * @param subtotalMinor  The amount the discount applies to. When a promotion
 *                       targets specific services this is the sum of THOSE
 *                       lines, not the whole basket — see `eligibleAmount`.
 */
export function calculateDiscount(rule: DiscountRule, subtotalMinor: bigint): DiscountResult {
  if (subtotalMinor <= 0n) {
    return { discountMinor: 0n, totalMinor: 0n, cappedBy: null };
  }

  let raw: bigint;
  let cappedBy: DiscountResult['cappedBy'] = null;

  if (rule.discountType === 'PERCENTAGE') {
    const bps = BigInt(rule.discountValueBps ?? 0);
    raw = (subtotalMinor * bps) / 10_000n;

    if (rule.maxDiscountMinor !== null && raw > rule.maxDiscountMinor) {
      raw = rule.maxDiscountMinor;
      cappedBy = 'maxDiscount';
    }
  } else {
    raw = rule.discountAmountMinor ?? 0n;
  }

  if (raw < 0n) raw = 0n;

  if (raw > subtotalMinor) {
    raw = subtotalMinor;
    // Overwrites a maxDiscount cap on purpose: if both applied, the binding one
    // is the one that actually decided the number.
    cappedBy = 'subtotal';
  }

  return { discountMinor: raw, totalMinor: subtotalMinor - raw, cappedBy };
}

/**
 * How much of a basket a promotion is allowed to discount.
 *
 * A promotion with no service targeting applies to everything. One that names
 * services applies only to those lines — 20% off colouring should not take 20%
 * off the haircut on the same ticket, and the difference is invisible until
 * somebody checks a receipt.
 *
 * Lines are matched by service, and a line with no service id (there is no such
 * thing today, but the type allows it) counts as untargeted and is excluded.
 */
export function eligibleAmount(
  lines: ReadonlyArray<{ serviceId: string | null; amountMinor: bigint }>,
  targetedServiceIds: ReadonlySet<string>,
): bigint {
  if (targetedServiceIds.size === 0) {
    return lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  }

  return lines.reduce(
    (sum, line) =>
      line.serviceId && targetedServiceIds.has(line.serviceId) ? sum + line.amountMinor : sum,
    0n,
  );
}

/**
 * Spread one discount back across the lines it came from.
 *
 * Needed because refunding one service out of three has to know how much of the
 * discount belonged to that service. Largest-remainder: allocate proportionally
 * with integer division, then hand the leftover minor units to the lines with
 * the biggest fractional parts.
 *
 * The property that matters, and that a test asserts: the allocation always
 * sums back to exactly the discount. A naive `round(share)` per line does not —
 * it drifts by a few minor units, and those units then live forever as an
 * unexplainable gap between the ticket and the ledger.
 */
export function allocateDiscount(
  lines: ReadonlyArray<{ id: string; amountMinor: bigint }>,
  discountMinor: bigint,
): Array<{ id: string; discountMinor: bigint }> {
  const total = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  if (total <= 0n || discountMinor <= 0n) {
    return lines.map((line) => ({ id: line.id, discountMinor: 0n }));
  }

  const allocations = lines.map((line) => {
    const exact = line.amountMinor * discountMinor;
    return {
      id: line.id,
      base: exact / total,
      remainder: exact % total,
    };
  });

  let assigned = allocations.reduce((sum, a) => sum + a.base, 0n);
  let leftover = discountMinor - assigned;

  // Biggest fractional part first; the id breaks ties so the result is stable
  // rather than dependent on the sort's implementation.
  const order = [...allocations].sort((a, b) =>
    a.remainder === b.remainder ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1,
  );

  const extra = new Map<string, bigint>();
  for (const allocation of order) {
    if (leftover <= 0n) break;
    extra.set(allocation.id, 1n);
    leftover -= 1n;
  }

  assigned = 0n;
  const result = allocations.map((allocation) => {
    const value = allocation.base + (extra.get(allocation.id) ?? 0n);
    assigned += value;
    return { id: allocation.id, discountMinor: value };
  });

  return result;
}
