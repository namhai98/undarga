import {
  anyContains,
  anyOverlaps,
  contains,
  intersect,
  merge,
  overlaps,
  subtract,
  subtractAll,
  type Interval,
} from './interval';

/** Compact constructor: minutes since an arbitrary origin. */
const iv = (start: number, end: number): Interval => ({ start, end });

describe('interval', () => {
  describe('overlaps', () => {
    it('is true when they share an instant', () => {
      expect(overlaps(iv(0, 10), iv(5, 15))).toBe(true);
      expect(overlaps(iv(5, 15), iv(0, 10))).toBe(true);
      expect(overlaps(iv(0, 100), iv(40, 50))).toBe(true);
    });

    it('is false for back-to-back intervals (half-open)', () => {
      expect(overlaps(iv(0, 10), iv(10, 20))).toBe(false);
      expect(overlaps(iv(10, 20), iv(0, 10))).toBe(false);
    });

    it('is false when disjoint', () => {
      expect(overlaps(iv(0, 10), iv(11, 20))).toBe(false);
    });
  });

  describe('contains', () => {
    it('allows touching endpoints', () => {
      expect(contains(iv(0, 10), iv(0, 10))).toBe(true);
      expect(contains(iv(0, 10), iv(2, 8))).toBe(true);
      expect(contains(iv(0, 10), iv(0, 11))).toBe(false);
      expect(contains(iv(0, 10), iv(-1, 5))).toBe(false);
    });
  });

  describe('merge', () => {
    it('coalesces overlapping and touching intervals', () => {
      expect(merge([iv(0, 10), iv(10, 20), iv(5, 8)])).toEqual([iv(0, 20)]);
    });

    it('keeps a gap', () => {
      expect(merge([iv(0, 10), iv(12, 20)])).toEqual([iv(0, 10), iv(12, 20)]);
    });

    it('drops zero-length and inverted inputs', () => {
      expect(merge([iv(5, 5), iv(10, 4), iv(0, 3)])).toEqual([iv(0, 3)]);
    });

    it('sorts unordered input', () => {
      expect(merge([iv(20, 30), iv(0, 10)])).toEqual([iv(0, 10), iv(20, 30)]);
    });
  });

  describe('subtract', () => {
    it('punches a hole in the middle', () => {
      expect(subtract(iv(0, 100), [iv(40, 60)])).toEqual([iv(0, 40), iv(60, 100)]);
    });

    it('trims an edge', () => {
      expect(subtract(iv(0, 100), [iv(-10, 30)])).toEqual([iv(30, 100)]);
      expect(subtract(iv(0, 100), [iv(80, 200)])).toEqual([iv(0, 80)]);
    });

    it('removes everything when fully covered', () => {
      expect(subtract(iv(0, 100), [iv(0, 100)])).toEqual([]);
      expect(subtract(iv(10, 20), [iv(0, 100)])).toEqual([]);
    });

    it('ignores a non-overlapping cut', () => {
      expect(subtract(iv(0, 10), [iv(20, 30)])).toEqual([iv(0, 10)]);
    });

    it('applies several cuts at once', () => {
      expect(subtract(iv(0, 100), [iv(10, 20), iv(50, 60), iv(90, 200)])).toEqual([
        iv(0, 10),
        iv(20, 50),
        iv(60, 90),
      ]);
    });
  });

  describe('subtractAll', () => {
    it('subtracts a cut set from a base set', () => {
      expect(subtractAll([iv(0, 50), iv(60, 100)], [iv(20, 30), iv(70, 80)])).toEqual([
        iv(0, 20),
        iv(30, 50),
        iv(60, 70),
        iv(80, 100),
      ]);
    });
  });

  describe('intersect', () => {
    it('returns the common instants of two sets', () => {
      expect(intersect([iv(0, 50)], [iv(20, 100)])).toEqual([iv(20, 50)]);
      expect(intersect([iv(0, 10), iv(20, 30)], [iv(5, 25)])).toEqual([iv(5, 10), iv(20, 25)]);
      expect(intersect([iv(0, 10)], [iv(20, 30)])).toEqual([]);
    });
  });

  describe('anyContains / anyOverlaps', () => {
    it('scans a set', () => {
      expect(anyContains([iv(0, 10), iv(20, 40)], iv(22, 38))).toBe(true);
      expect(anyContains([iv(0, 10), iv(20, 40)], iv(8, 22))).toBe(false);
      expect(anyOverlaps([iv(0, 10), iv(20, 40)], iv(8, 22))).toBe(true);
      expect(anyOverlaps([iv(0, 10), iv(20, 40)], iv(10, 20))).toBe(false);
    });
  });
});
