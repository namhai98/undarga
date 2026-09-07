'use client';

import { EmployeeList } from '@/features/employees';

/**
 * Staff administration.
 *
 * A thin route: the slice owns the screen, and `app/` only decides where it
 * lives (`features/README.md` — a feature is imported through its index and
 * nothing else).
 */
export default function StaffPage() {
  return <EmployeeList />;
}
