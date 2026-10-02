import { PublicBookingPage } from '@/features/public-booking';

/**
 * `/book/:companySlug` — a company's public booking page.
 *
 * A Server Component that awaits `params` (a Promise in Next 16) and hands the
 * slug to the client flow, the same shape as `/customers/[customerId]`. The
 * slug is only a lookup key: the API decides whether it names a company that
 * takes online bookings.
 */
export default async function BookPage(props: PageProps<'/book/[companySlug]'>) {
  const { companySlug } = await props.params;

  return <PublicBookingPage companySlug={companySlug} />;
}
