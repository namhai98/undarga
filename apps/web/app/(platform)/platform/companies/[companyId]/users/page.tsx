import { PlatformCompanyUsers } from '@/features/platform';

/** Everyone who can sign in to one tenant — searchable, filterable, paged. */
export default async function PlatformCompanyUsersPage(
  props: PageProps<'/platform/companies/[companyId]/users'>,
) {
  const { companyId } = await props.params;

  return <PlatformCompanyUsers companyId={companyId} />;
}
