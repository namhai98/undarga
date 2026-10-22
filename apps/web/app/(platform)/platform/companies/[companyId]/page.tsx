import { PlatformCompanyDetail } from '@/features/platform';

/**
 * One tenant.
 *
 * A Server Component that awaits `params` — a Promise in Next 16 — and hands a
 * plain string to the client component, keeping the client boundary at the part
 * that needs the operator session.
 */
export default async function PlatformCompanyPage(
  props: PageProps<'/platform/companies/[companyId]'>,
) {
  const { companyId } = await props.params;

  return <PlatformCompanyDetail companyId={companyId} />;
}
