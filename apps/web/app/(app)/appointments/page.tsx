'use client';

import { AppointmentList } from '@/features/appointments';

/** A thin route: the slice owns the screen (`features/README.md`). */
export default function AppointmentsPage() {
  return <AppointmentList />;
}
