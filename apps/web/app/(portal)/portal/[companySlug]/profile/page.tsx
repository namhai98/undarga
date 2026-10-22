import { PortalProfile } from '@/features/customer-portal';

export default async function PortalProfilePage(props: PageProps<'/portal/[companySlug]/profile'>) {
  const { companySlug } = await props.params;
  return <PortalProfile slug={companySlug} />;
}
