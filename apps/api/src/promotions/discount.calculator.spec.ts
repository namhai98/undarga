import { allocateDiscount, calculateDiscount, eligibleAmount } from './discount.calculator';

/**
 * The calculator is pure, so it can be pinned exhaustively here rather than
 * inferred from an e2e test that also had to stand up a company, a customer and
 * an appointment to see one number.
 */
describe('calculateDiscount', () => {
  const percentage = (bps: number, max: bigint | null = null) =>
    ({
      discountType: 'PERCENTAGE' as const,
      discountValueBps: bps,
      discountAmountMinor: null,
      maxDiscountMinor: max,
    });

  const fixed = (amount: bigint) =>
    ({
      discountType: 'FIXED_AMOUNT' as const,
      discountValueBps: null,
      discountAmountMinor: amount,
      maxDiscountMinor: null,
    });

  describe('percentages', () => {
    it.each([
      [1000, 100_000n, 10_000n],
      [1500, 100_000n, 15_000n],
      [10000, 100_000n, 100_000n],
      [1, 100_000n, 10n],
    ])('%i bps of %s is %s', (bps, subtotal, expected) => {
      expect(calculateDiscount(percentage(bps), subtotal).discountMinor).toBe(expected);
    });

    it('rounds the discount DOWN, so the customer never pays less than advertised', () => {
      // 33.33% of 1000 is 3333/10000 = 333.3 minor units. Truncation gives 333,
      // so the customer pays 667 rather than 666 — the company never
      // accidentally gives away more than it published.
      const result = calculateDiscount(percentage(3333), 1000n);
      expect(result.discountMinor).toBe(333n);
      expect(result.totalMinor).toBe(667n);
    });

    it('does not lose precision on an amount past 2^53', () => {
      // The reason the whole codebase carries money as BigInt. As a float this
      // multiplication rounds, and the discount comes out wrong by hundreds.
      const subtotal = 90_071_992_547_409_920n;
      expect(calculateDiscount(percentage(1500), subtotal).discountMinor).toBe(
        13_510_798_882_111_488n,
      );
    });

    it('honours a cap and says the cap is what bound it', () => {
      const result = calculateDiscount(percentage(2000, 5_000n), 100_000n);
      expect(result.discountMinor).toBe(5_000n);
      expect(result.cappedBy).toBe('maxDiscount');
    });

    it('ignores a cap that is above the computed discount', () => {
      const result = calculateDiscount(percentage(1000, 50_000n), 100_000n);
      expect(result.discountMinor).toBe(10_000n);
      expect(result.cappedBy).toBeNull();
    });
  });

  describe('fixed amounts', () => {
    it('takes off exactly what it says', () => {
      const result = calculateDiscount(fixed(5_000n), 30_000n);
      expect(result).toMatchObject({ discountMinor: 5_000n, totalMinor: 25_000n, cappedBy: null });
    });

    it('never produces a negative total', () => {
      /**
       * The case that matters. A 50,000 voucher against a 30,000 basket is an
       * ordinary thing to configure, and without the clamp the total goes
       * negative — which flows into the appointment total, the payment amount
       * and the revenue report before anybody notices.
       */
      const result = calculateDiscount(fixed(50_000n), 30_000n);
      expect(result.discountMinor).toBe(30_000n);
      expect(result.totalMinor).toBe(0n);
      expect(result.cappedBy).toBe('subtotal');
    });

    it('reports the subtotal as the binding cap even when a maximum also applied', () => {
      const result = calculateDiscount(
        { ...percentage(10000), maxDiscountMinor: 20_000n },
        10_000n,
      );
      // 100% of 10,000 is 10,000; the 20,000 cap never bites.
      expect(result.discountMinor).toBe(10_000n);
    });
  });

  it('discounts nothing on an empty or negative basket', () => {
    for (const subtotal of [0n, -1n, -5_000n]) {
      expect(calculateDiscount(fixed(1_000n), subtotal)).toMatchObject({
        discountMinor: 0n,
        totalMinor: 0n,
      });
    }
  });
});

describe('eligibleAmount', () => {
  const lines = [
    { serviceId: 'cut', amountMinor: 30_000n },
    { serviceId: 'colour', amountMinor: 70_000n },
    { serviceId: null, amountMinor: 5_000n },
  ];

  it('is the whole basket when a promotion targets nothing', () => {
    expect(eligibleAmount(lines, new Set())).toBe(105_000n);
  });

  it('is only the targeted lines when it does', () => {
    // 20% off colouring must not take 20% off the haircut on the same ticket,
    // and the difference is invisible until somebody checks a receipt.
    expect(eligibleAmount(lines, new Set(['colour']))).toBe(70_000n);
  });

  it('excludes a line with no service from a targeted promotion', () => {
    expect(eligibleAmount(lines, new Set(['cut', 'colour']))).toBe(100_000n);
  });

  it('is zero when nothing on the ticket qualifies', () => {
    expect(eligibleAmount(lines, new Set(['massage']))).toBe(0n);
  });
});

describe('allocateDiscount', () => {
  it('always sums back to exactly the discount', () => {
    /**
     * The property the whole function exists for. A naive `round(share)` per
     * line drifts by a few minor units, and those units then live forever as an
     * unexplainable gap between the ticket and the ledger.
     */
    const lines = [
      { id: 'a', amountMinor: 3_333n },
      { id: 'b', amountMinor: 3_333n },
      { id: 'c', amountMinor: 3_334n },
    ];

    for (const discount of [1n, 7n, 100n, 999n, 5_000n, 10_000n]) {
      const allocation = allocateDiscount(lines, discount);
      const sum = allocation.reduce((total, line) => total + line.discountMinor, 0n);
      expect(sum).toBe(discount);
    }
  });

  it('splits proportionally', () => {
    const allocation = allocateDiscount(
      [
        { id: 'small', amountMinor: 25_000n },
        { id: 'large', amountMinor: 75_000n },
      ],
      10_000n,
    );

    expect(allocation).toEqual([
      { id: 'small', discountMinor: 2_500n },
      { id: 'large', discountMinor: 7_500n },
    ]);
  });

  it('gives the leftover minor unit to the biggest fractional part', () => {
    // 1 minor unit across three equal lines: exactly one of them gets it, and
    // which one is stable rather than dependent on the sort implementation.
    const allocation = allocateDiscount(
      [
        { id: 'a', amountMinor: 100n },
        { id: 'b', amountMinor: 100n },
        { id: 'c', amountMinor: 100n },
      ],
      1n,
    );

    expect(allocation.filter((line) => line.discountMinor === 1n)).toHaveLength(1);
    expect(allocation.map((l) => l.id)).toEqual(['a', 'b', 'c']);
  });

  it('allocates nothing across a zero-value basket', () => {
    const allocation = allocateDiscount([{ id: 'a', amountMinor: 0n }], 500n);
    expect(allocation).toEqual([{ id: 'a', discountMinor: 0n }]);
  });
});
