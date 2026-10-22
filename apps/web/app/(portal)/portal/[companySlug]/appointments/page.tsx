import { PortalAppointments } from '@/features/customer-portal';

export default async function PortalAppointmentsPage(props: PageProps<'/portal/[companySlug]/appointments'>) {
  const { companySlug } = await props.params;
  return <PortalAppointments slug={companySlug} />;
}
