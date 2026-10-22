import { PortalOverview } from '@/features/customer-portal';

export default async function PortalOverviewPage(props: PageProps<'/portal/[companySlug]'>) {
  const { companySlug } = await props.params;
  return <PortalOverview slug={companySlug} />;
}
