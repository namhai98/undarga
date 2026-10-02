'use client';

import { AvailabilityExplorer } from '@/features/availability';

/**
 * A thin route: the slice owns the screen, `app/` only places it
 * (`features/README.md` — a feature is imported through its index and nothing
 * else).
 */
export default function AvailabilityPage() {
  return <AvailabilityExplorer />;
}
