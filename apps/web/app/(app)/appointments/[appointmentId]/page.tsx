import { AppointmentDetail } from '@/features/appointments';

/**
 * One appointment. A Server Component that awaits `params` — a Promise in
 * Next 16 — and hands a plain string to the client component, the same shape
 * as `/customers/[customerId]`.
 */
export default async function AppointmentDetailPage(
  props: PageProps<'/appointments/[appointmentId]'>,
) {
  const { appointmentId } = await props.params;

  return <AppointmentDetail appointmentId={appointmentId} />;
}
