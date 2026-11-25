import { booking } from './mn/booking';
import { core } from './mn/core';
import { money } from './mn/money';
import { ops } from './mn/ops';
import { people } from './mn/people';
import { phrases } from './mn/phrases';
import { team } from './mn/team';

/**
 * Mongolian. Keyed by the English sentence exactly as written in the code;
 * a missing entry falls back to English. Split by area only to keep the
 * files readable.
 */
export const mn: Record<string, string> = {
  ...core,
  ...money,
  ...people,
  ...team,
  ...booking,
  ...ops,
  ...phrases,
};
