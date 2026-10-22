import { PortalShell } from '@/features/customer-portal';

/** One business's portal. The sign-in gate lives in PortalShell. */
export default async function CustomerPortalLayout(props: LayoutProps<'/portal/[companySlug]'>) {
  const { companySlug } = await props.params;
  return <PortalShell slug={companySlug}>{props.children}</PortalShell>;
}
