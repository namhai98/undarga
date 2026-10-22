import { PortalAppointment } from '@/features/customer-portal';

export default async function PortalAppointmentPage(
  props: PageProps<'/portal/[companySlug]/appointments/[appointmentId]'>,
) {
  const { companySlug, appointmentId } = await props.params;
  return <PortalAppointment slug={companySlug} id={appointmentId} />;
}
