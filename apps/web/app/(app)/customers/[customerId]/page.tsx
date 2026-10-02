import { CustomerGiftCards } from '@/features/billing';
import { CustomerDetail } from '@/features/customers';
import { CustomerNotificationPreferences } from '@/features/notifications';

/**
 * One customer.
 *
 * A Server Component that awaits `params` — a Promise in Next 16 — and hands a
 * plain string to the client component. Keeps the client boundary at the piece
 * that actually needs the session, and needs no `<Suspense>` wrapper.
 */
export default async function CustomerDetailPage(props: PageProps<'/customers/[customerId]'>) {
  const { customerId } = await props.params;

  return (
    <CustomerDetail customerId={customerId}>
      <CustomerGiftCards customerId={customerId} />
      <CustomerNotificationPreferences customerId={customerId} />
    </CustomerDetail>
  );
}
