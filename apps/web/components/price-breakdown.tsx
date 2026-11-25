'use client';

import { formatMoney } from '@undarga/shared';
import { currencyFormat } from '@/lib/currency';
import { useT } from '@/lib/i18n';

/**
 * Original price, discount, final price — as the server computed them.
 *
 * Display only. It takes three minor-unit strings and formats them; it never
 * subtracts one from another. The discount engine on the API is the only place
 * a final price is calculated, so this cannot disagree with what is charged.
 */
export function PriceBreakdown(props: {
  originalMinor: string;
  discountMinor: string;
  finalMinor: string;
  currencyCode: string;
  /** Shown beside the discount, e.g. the promotion's name. */
  discountLabel?: string | null;
}) {
  const t = useT();
  const money = (minor: string) =>
    formatMoney(
      { amountMinor: minor, currencyCode: props.currencyCode },
      currencyFormat(props.currencyCode),
    );
  const discounted = props.discountMinor !== '0';

  return (
    <dl className="grid gap-1 text-sm" aria-label={t('Price')}>
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">{t('Original price')}</dt>
        <dd className={`tabular-nums ${discounted ? 'text-muted-foreground line-through' : ''}`}>
          {money(props.originalMinor)}
        </dd>
      </div>
      {discounted ? (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">
            {t('Discount')}
            {props.discountLabel ? ` (${props.discountLabel})` : ''}
          </dt>
          <dd className="text-primary tabular-nums">−{money(props.discountMinor)}</dd>
        </div>
      ) : null}
      <div className="border-border/60 flex justify-between gap-4 border-t pt-1 font-semibold">
        <dt>{t('Final price')}</dt>
        <dd className="tabular-nums">{money(props.finalMinor)}</dd>
      </div>
    </dl>
  );
}
