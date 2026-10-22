import { PortalGiftCards } from '@/features/customer-portal';

export default async function PortalGiftCardsPage(props: PageProps<'/portal/[companySlug]/gift-cards'>) {
  const { companySlug } = await props.params;
  return <PortalGiftCards slug={companySlug} />;
}
