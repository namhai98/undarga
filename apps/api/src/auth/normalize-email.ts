/**
 * Normalise an address for storage and comparison.
 *
 * `User@Example.COM` and `user@example.com` are the same mailbox everywhere
 * that matters, so they must be the same account. The column is `citext` with a
 * unique index, so the database already compares case-insensitively — this
 * makes what is STORED consistent too, which matters because the address is
 * displayed back to people and used to build link emails.
 *
 * Trimming is here because a trailing space pasted from a spreadsheet is the
 * single most common way a login mysteriously fails.
 *
 * Deliberately NOT doing provider-specific normalisation — stripping dots, or
 * `+tags`, the way Gmail treats them. Those are one provider's rules, they are
 * wrong for others, and applying them would silently merge addresses a user
 * considers distinct.
 *
 * One definition, imported by everything that touches an address, so login and
 * account recovery can never disagree about what counts as the same person.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
