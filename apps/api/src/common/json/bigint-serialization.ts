/**
 * Teach JSON.stringify how to serialise BigInt.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * Every money column in the schema is `BigInt` minor units — see
 * docs/DATABASE.md §16. Prisma therefore hands back `bigint` values, and
 * `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`
 * on all of them.
 *
 * Without this, *every* endpoint that returns money 500s. It is not a niche
 * edge case; it is the default behaviour of the whole API.
 *
 * ---------------------------------------------------------------------------
 * WHY A STRING AND NOT A NUMBER
 * ---------------------------------------------------------------------------
 *
 * `Number(bigint)` is the tempting one-liner and it is wrong. A JS number holds
 * integers exactly only up to 2^53 - 1. Minor units make that ceiling closer
 * than it looks: for a currency with two decimal places it is about 90 trillion
 * major units, which an aggregate over a large tenant's lifetime revenue can
 * reach — and the failure mode is a silently rounded amount, not an error.
 *
 * Money crossing the wire as a string is the same discipline the database
 * uses. Clients parse it deliberately; nothing rounds it by accident.
 *
 * ---------------------------------------------------------------------------
 * WHY A PROTOTYPE PATCH
 * ---------------------------------------------------------------------------
 *
 * Patching a global is not free, and the alternatives were considered:
 *
 *   - A response interceptor walking every payload: slower on large lists,
 *     and it does not cover error bodies, logger output, or anything that
 *     stringifies outside the Nest response pipeline.
 *   - A custom `replacer` at each call site: one forgotten call site is a 500
 *     in production.
 *
 * `toJSON` is the mechanism JSON.stringify is designed to consult, so this is
 * the intended extension point rather than a hack — it just happens to live on
 * a built-in. Imported for its side effect by AppModule, so it is active in the
 * server, in tests, and in scripts alike.
 */

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof BigInt.prototype.toJSON !== 'function') {
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

export {};
