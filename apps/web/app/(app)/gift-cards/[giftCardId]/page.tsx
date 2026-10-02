import { GiftCardDetail } from '@/features/billing';

/**
 * One gift card.
 *
 * A Server Component that awaits `params` — a Promise in Next 16 — and hands a
 * plain string to the client component, as the customer page does.
 */
export default async function GiftCardDetailPage(props: PageProps<'/gift-cards/[giftCardId]'>) {
  const { giftCardId } = await props.params;

  return <GiftCardDetail giftCardId={giftCardId} />;
}
