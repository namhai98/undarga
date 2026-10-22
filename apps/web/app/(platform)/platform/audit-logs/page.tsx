import { PlatformAuditLog } from '@/features/platform';

/**
 * The audit trail, optionally narrowed to one company.
 *
 * `searchParams` is a Promise in Next 16; awaiting it here and passing a plain
 * string keeps the client component free of routing concerns.
 */
export default async function PlatformAuditLogsPage(props: PageProps<'/platform/audit-logs'>) {
  const params = await props.searchParams;
  const companyId = typeof params.companyId === 'string' ? params.companyId : undefined;

  return <PlatformAuditLog companyId={companyId} />;
}
