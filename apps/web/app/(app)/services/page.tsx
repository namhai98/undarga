'use client';

import { ServiceList } from '@/features/catalog';

/**
 * The service catalog.
 *
 * A thin route: the slice owns the screen, and `app/` only decides where it
 * lives (`features/README.md` — a feature is imported through its index and
 * nothing else).
 */
export default function ServicesPage() {
  return <ServiceList />;
}
