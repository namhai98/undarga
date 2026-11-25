'use client';

import { decimalToMinorString, formatMoney, minorToDecimalString } from '@undarga/shared';
import { Loader2, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useServices } from '@/features/catalog';
import { useCompany } from '@/features/companies';
import { useEmployees } from '@/features/employees';
import { currencyFormat } from '@/lib/currency';
import { ApiError } from '@/services/api-error';
import type {
  DiscountType,
  Promotion,
  PromotionInput,
  PromotionStatus,
} from '@/services/billing.service';
import {
  useArchivePromotion,
  usePromotions,
  useQuotePromotion,
  useSavePromotion,
  useSetPromotionStatus,
} from '../api/use-billing';
import { useT } from '@/lib/i18n';

const PAGE_SIZE = 25;

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Discounts.
 *
 * ---------------------------------------------------------------------------
 * PERCENTAGES ARE TYPED AS PERCENTAGES AND SENT AS BASIS POINTS
 * ---------------------------------------------------------------------------
 *
 * Nobody types "1500" meaning 15%. The form takes 15 and multiplies by 100 —
 * integer arithmetic, so no float ever touches a discount. The API refuses
 * anything outside 1–10000, and the database has a CHECK underneath that.
 */
export function PromotionList() {
  const t = useT();
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [archiving, setArchiving] = useState<Promotion | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canWrite = useCan('promotion:write');
  const company = useCompany();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<PromotionStatus | ''>('');
  const [typeFilter, setTypeFilter] = useState<DiscountType | ''>('');
  const [offset, setOffset] = useState(0);
  // Every filter is a server query — the list is paged, so filtering the
  // current page in the browser would silently miss the rest.
  const promotions = usePromotions({
    ...(search ? { search } : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(typeFilter ? { discountType: typeFilter } : {}),
    limit: PAGE_SIZE,
    offset,
  });
  const archive = useArchivePromotion();
  const setStatus = useSetPromotionStatus();
  const total = promotions.data?.total ?? 0;
  const filtered = Boolean(search || statusFilter || typeFilter);
  /** Any filter change goes back to the first page. */
  const change = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  const currencyCode = company.data?.currencyCode ?? 'MNT';
  const money = (minor: string) =>
    formatMoney({ amountMinor: minor, currencyCode }, currencyFormat(currencyCode));

  const items = promotions.data?.items ?? [];

  const toggle = async (promotion: Promotion) => {
    setError(null);
    try {
      await setStatus.mutateAsync({
        promotionId: promotion.id,
        status: promotion.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('Could not change the status.'));
    }
  };

  const doArchive = async (promotion: Promotion) => {
    setError(null);
    try {
      await archive.mutateAsync(promotion.id);
      setArchiving(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('Could not archive the promotion.'));
    }
  };

  if (editing) {
    return (
      <PromotionForm
        promotion={editing === 'new' ? null : editing}
        currencyCode={currencyCode}
        onDone={() => setEditing(null)}
      />
    );
  }

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">{t('Promotions')}</h2>
          <p className="text-muted-foreground text-sm">
            {promotions.isPending
              ? t('Loading…')
              : `${total} ${total === 1 ? 'promotion' : 'promotions'}`}
          </p>
        </div>
        {canWrite ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            {t('Add promotion')}
          </Button>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Not done')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {archiving ? (
        <Alert role="alert">
          <AlertTitle>{t('Archive “{name}”?', { name: archiving.name })}</AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {t(
                'It stops applying immediately. Past redemptions keep referencing it, so old receipts can still name the discount they used.',
              )}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={archive.isPending}
                onClick={() => void doArchive(archiving)}
              >
                {archive.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('Archive')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setArchiving(null)}>
                {t('Keep')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      <QuoteTool currencyCode={currencyCode} money={money} />

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="promo-search">{t('Search')}</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="promo-search"
              value={search}
              placeholder={t('Name or code')}
              className="pl-8"
              onChange={(e) => change(() => setSearch(e.target.value))}
            />
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="promo-filter-status">{t('Status')}</Label>
          <select
            id="promo-filter-status"
            value={statusFilter}
            className={selectClass}
            onChange={(e) => change(() => setStatusFilter(e.target.value as PromotionStatus | ''))}
          >
            <option value="">{t('All')}</option>
            {(['ACTIVE', 'PAUSED', 'DRAFT', 'EXPIRED'] as const).map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="promo-filter-type">{t('Type')}</Label>
          <select
            id="promo-filter-type"
            value={typeFilter}
            className={selectClass}
            onChange={(e) => change(() => setTypeFilter(e.target.value as DiscountType | ''))}
          >
            <option value="">{t('All')}</option>
            <option value="PERCENTAGE">{t('Percentage')}</option>
            <option value="FIXED_AMOUNT">{t('Fixed amount')}</option>
          </select>
        </div>
      </div>

      {promotions.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not load promotions')}</AlertTitle>
          <AlertDescription>{t('Please try again.')}</AlertDescription>
        </Alert>
      ) : null}

      {promotions.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">{t('Loading promotions…')}</span>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : null}

      {!promotions.isPending && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? t('Nothing matches those filters') : t('No promotions yet')}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {t(
              'A promotion can take a percentage or a fixed amount off, optionally limited to certain services, branches or staff.',
            )}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Name')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Code')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Discount')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Runs')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('Used')}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t('State')}
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">{t('Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((promotion) => (
                <tr key={promotion.id} className="border-border/40 border-b last:border-0">
                  <td className="py-2 pr-3">
                    <span className="font-medium">{promotion.name}</span>
                    {promotion.isAutoApply ? (
                      <span className="text-muted-foreground ml-2 text-xs">{t('automatic')}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{promotion.code ?? '—'}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {promotion.discountType === 'PERCENTAGE'
                      ? `${(promotion.discountValueBps ?? 0) / 100}%`
                      : money(promotion.discountAmountMinor ?? '0')}
                    {promotion.maxDiscountMinor ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        {t('max {amount}', { amount: money(promotion.maxDiscountMinor) })}
                      </span>
                    ) : null}
                  </td>
                  <td className="text-muted-foreground py-2 pr-3 whitespace-nowrap">
                    {new Date(promotion.startsAt).toLocaleDateString()} –{' '}
                    {promotion.endsAt ? new Date(promotion.endsAt).toLocaleDateString() : 'open'}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {promotion.redeemedCount}
                    {promotion.maxRedemptions !== null ? ` / ${promotion.maxRedemptions}` : ''}
                  </td>
                  <td className="py-2 pr-3">
                    {/* `isLive` is derived by the API, so a promotion that ran
                        out yesterday reads correctly today. */}
                    <Badge variant={promotion.isLive ? 'default' : 'secondary'}>
                      {promotion.isLive ? 'live' : promotion.status.toLowerCase()}
                    </Badge>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {canWrite ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(promotion)}>
                          {t('Edit')}
                        </Button>
                        {promotion.status === 'ACTIVE' || promotion.status === 'PAUSED' ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={setStatus.isPending}
                            onClick={() => void toggle(promotion)}
                          >
                            {promotion.status === 'ACTIVE' ? t('Deactivate') : t('Activate')}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => setArchiving(promotion)}
                        >
                          {t('Archive')}
                        </Button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {t('{from}–{to} of {total}', {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, total),
              total: total,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || promotions.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t('Previous')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || promotions.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {t('Next')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** "What would this take off?" — the same evaluator the till will use. */
function QuoteTool({
  currencyCode,
  money,
}: {
  currencyCode: string;
  money: (minor: string) => string;
}) {
  const t = useT();
  const format = currencyFormat(currencyCode);
  const [subtotal, setSubtotal] = useState('');
  const quote = useQuotePromotion();

  const parsed = decimalToMinorString(subtotal, format.minorUnit);

  return (
    <div className="border-border/60 grid gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="quote-subtotal">
            {t('Try a basket ({currencyCode})', { currencyCode })}
          </Label>
          <Input
            id="quote-subtotal"
            inputMode="decimal"
            value={subtotal}
            className="tabular-nums"
            placeholder="100000"
            onChange={(e) => setSubtotal(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={!parsed || quote.isPending}
          onClick={() => quote.mutate({ subtotalMinor: parsed! })}
        >
          {quote.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Best automatic discount')}
        </Button>
      </div>

      {quote.data ? (
        quote.data.applicable ? (
          <p className="text-sm">
            <span className="font-medium">{quote.data.promotionName}</span> {t('takes off')}{' '}
            <span className="font-semibold tabular-nums">{money(quote.data.discountMinor!)}</span>
            {t(', leaving')} <span className="tabular-nums">{money(quote.data.totalMinor!)}</span>
            {quote.data.cappedBy === 'subtotal' ? (
              // Not an error: a fixed voucher larger than the basket is an
              // ordinary configuration, and the total is clamped at zero.
              <span className="text-muted-foreground"> {t('(capped at the basket total)')}</span>
            ) : null}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{quote.data.problem?.message}</p>
        )
      ) : null}
    </div>
  );
}

function PromotionForm({
  promotion,
  currencyCode,
  onDone,
}: {
  promotion: Promotion | null;
  currencyCode: string;
  onDone: () => void;
}) {
  const t = useT();
  const format = currencyFormat(currencyCode);
  const save = useSavePromotion(promotion?.id ?? null);

  const [name, setName] = useState(promotion?.name ?? '');
  const [discountType, setDiscountType] = useState<DiscountType>(
    promotion?.discountType ?? 'PERCENTAGE',
  );
  const [percent, setPercent] = useState(
    promotion?.discountValueBps ? String(promotion.discountValueBps / 100) : '',
  );
  const [amount, setAmount] = useState(
    promotion?.discountAmountMinor
      ? minorToDecimalString(promotion.discountAmountMinor, format.minorUnit)
      : '',
  );
  const [startsAt, setStartsAt] = useState(
    (promotion?.startsAt ?? new Date().toISOString()).slice(0, 10),
  );
  const [endsAt, setEndsAt] = useState(promotion?.endsAt?.slice(0, 10) ?? '');
  const [maxRedemptions, setMaxRedemptions] = useState(
    promotion?.maxRedemptions ? String(promotion.maxRedemptions) : '',
  );
  const [minPurchase, setMinPurchase] = useState(
    promotion?.minPurchaseMinor
      ? minorToDecimalString(promotion.minPurchaseMinor, format.minorUnit)
      : '',
  );
  const [isAutoApply, setIsAutoApply] = useState(promotion?.isAutoApply ?? false);
  const [code, setCode] = useState(promotion?.code ?? '');
  const [perCustomer, setPerCustomer] = useState(
    promotion?.maxRedemptionsPerCustomer ? String(promotion.maxRedemptionsPerCustomer) : '',
  );
  const [serviceIds, setServiceIds] = useState<string[]>(promotion?.serviceIds ?? []);
  const [branchIds, setBranchIds] = useState<string[]>(promotion?.branchIds ?? []);
  const [employeeIds, setEmployeeIds] = useState<string[]>(promotion?.employeeIds ?? []);
  const services = useServices({ status: 'ACTIVE', limit: 100 });
  const branches = useBranches();
  const employees = useEmployees({ status: 'ACTIVE', limit: 100 });
  const [status, setStatus] = useState(promotion?.status ?? 'ACTIVE');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    setError(null);
    const errors: Record<string, string> = {};

    if (name.trim().length === 0) errors.name = 'Give the promotion a name.';

    let discountValueBps: number | undefined;
    let discountAmountMinor: string | undefined;

    if (discountType === 'PERCENTAGE') {
      const value = Number(percent);
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        errors.percent = 'Enter a percentage between 0 and 100.';
      } else {
        // Integer basis points, never a float discount.
        discountValueBps = Math.round(value * 100);
      }
    } else {
      const parsed = decimalToMinorString(amount, format.minorUnit);
      if (!parsed || BigInt(parsed) <= 0n) errors.amount = 'Enter an amount.';
      else discountAmountMinor = parsed;
    }

    if (endsAt && endsAt <= startsAt) errors.endsAt = 'The end must be after the start.';
    const normalisedCode = code.trim().toUpperCase();
    if (normalisedCode && !/^[A-Z0-9][A-Z0-9_-]{2,47}$/.test(normalisedCode)) {
      errors.code = 'Use 3–48 letters, digits, hyphens or underscores.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const input: PromotionInput = {
      name: name.trim(),
      status: status as PromotionInput['status'],
      discountType,
      ...(discountValueBps !== undefined ? { discountValueBps } : {}),
      ...(discountAmountMinor !== undefined ? { discountAmountMinor } : {}),
      startsAt: new Date(`${startsAt}T00:00:00.000Z`).toISOString(),
      endsAt: endsAt ? new Date(`${endsAt}T00:00:00.000Z`).toISOString() : null,
      minPurchaseMinor: minPurchase ? decimalToMinorString(minPurchase, format.minorUnit) : null,
      maxRedemptions: maxRedemptions ? Number(maxRedemptions) : null,
      maxRedemptionsPerCustomer: perCustomer ? Number(perCustomer) : null,
      // A code-only promotion is never automatic; the server enforces it too.
      isAutoApply: normalisedCode ? false : isAutoApply,
      code: normalisedCode || null,
      serviceIds,
      branchIds,
      employeeIds,
    };

    try {
      await save.mutateAsync(input);
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('Could not save the promotion.'));
    }
  };

  return (
    <section className="grid max-w-2xl gap-5">
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">
          {promotion ? t('Edit promotion') : t('New promotion')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t(
            'The server decides what a promotion is worth. Nothing here sends a discount amount for a booking.',
          )}
        </p>
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not save')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Field id="promo-name" label={t('Name')} error={fieldErrors.name}>
        <Input
          id="promo-name"
          value={name}
          maxLength={160}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="promo-type" label={t('Discount type')}>
          <select
            id="promo-type"
            value={discountType}
            className={selectClass}
            onChange={(e) => setDiscountType(e.target.value as DiscountType)}
          >
            <option value="PERCENTAGE">{t('Percentage')}</option>
            <option value="FIXED_AMOUNT">{t('Fixed amount')}</option>
          </select>
        </Field>

        {discountType === 'PERCENTAGE' ? (
          <Field id="promo-percent" label={t('Percentage off')} error={fieldErrors.percent}>
            <div className="flex items-center gap-2">
              <Input
                id="promo-percent"
                inputMode="decimal"
                value={percent}
                className="w-24 tabular-nums"
                placeholder="15"
                onChange={(e) => setPercent(e.target.value)}
              />
              <span className="text-muted-foreground text-sm">%</span>
            </div>
          </Field>
        ) : (
          <Field
            id="promo-amount"
            label={t('Amount off ({currencyCode})', { currencyCode })}
            error={fieldErrors.amount}
          >
            <Input
              id="promo-amount"
              inputMode="decimal"
              value={amount}
              className="tabular-nums"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="promo-starts" label={t('Starts')}>
          <Input
            id="promo-starts"
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </Field>
        <Field
          id="promo-ends"
          label={t('Ends')}
          hint={t('Leave blank to run indefinitely.')}
          error={fieldErrors.endsAt}
        >
          <Input
            id="promo-ends"
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      </div>

      <Field
        id="promo-code"
        label={t('Promotion code (optional)')}
        hint={t(
          'Customers type this when booking. A promotion with a code can only be used with it.',
        )}
        error={fieldErrors.code}
      >
        <Input
          id="promo-code"
          value={code}
          maxLength={48}
          className="font-mono uppercase sm:max-w-xs"
          placeholder="SUMMER20"
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-4">
        <Field
          id="promo-min"
          label={t('Minimum spend ({currencyCode})', { currencyCode })}
          hint={t('Measured against the whole basket.')}
        >
          <Input
            id="promo-min"
            inputMode="decimal"
            value={minPurchase}
            className="tabular-nums"
            onChange={(e) => setMinPurchase(e.target.value)}
          />
        </Field>
        <Field id="promo-max" label={t('Usage limit')} hint={t('Blank for unlimited.')}>
          <Input
            id="promo-max"
            type="number"
            min={1}
            value={maxRedemptions}
            className="w-28 tabular-nums"
            onChange={(e) => setMaxRedemptions(e.target.value)}
          />
        </Field>
        <Field id="promo-per-customer" label={t('Per customer')} hint={t('Blank for unlimited.')}>
          <Input
            id="promo-per-customer"
            type="number"
            min={1}
            value={perCustomer}
            className="w-28 tabular-nums"
            onChange={(e) => setPerCustomer(e.target.value)}
          />
        </Field>
        <Field id="promo-status" label={t('Status')}>
          <select
            id="promo-status"
            value={status}
            className={selectClass}
            onChange={(e) => setStatus(e.target.value as Promotion['status'])}
          >
            {['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="flex items-start gap-2.5">
        <input
          id="promo-auto"
          type="checkbox"
          checked={isAutoApply && !code.trim()}
          disabled={Boolean(code.trim())}
          className="border-input accent-primary mt-0.5 size-4 rounded"
          onChange={(e) => setIsAutoApply(e.target.checked)}
        />
        <div className="grid gap-0.5">
          <Label htmlFor="promo-auto" className="font-normal">
            {t('Apply automatically')}
          </Label>
          <p className="text-muted-foreground text-xs">
            {t('The till offers the best eligible automatic discount without anyone naming it.')}
            {code.trim() ? t(' Not available for a promotion with a code.') : ''}
          </p>
        </div>
      </div>

      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">{t('Applies to')}</legend>
        <p className="text-muted-foreground -mt-2 text-xs">
          {t('Leave a list empty to include everything of that kind.')}
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <CheckList
            label={t('Services')}
            options={(services.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }))}
            selected={serviceIds}
            onChange={setServiceIds}
          />
          <CheckList
            label={t('Branches')}
            options={(branches.data?.items ?? []).map((b) => ({ id: b.id, name: b.name }))}
            selected={branchIds}
            onChange={setBranchIds}
          />
          <CheckList
            label={t('Staff')}
            options={(employees.data?.items ?? []).map((e) => ({ id: e.id, name: e.displayName }))}
            selected={employeeIds}
            onChange={setEmployeeIds}
          />
        </div>
      </fieldset>

      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => void submit()}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {promotion ? t('Save changes') : t('Create promotion')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {t('Cancel')}
        </Button>
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Pick any number from a list. Selected ids that are no longer offered (a
 * service since archived) stay selected and are shown, so saving never drops
 * targeting silently.
 */
function CheckList(props: {
  label: string;
  options: Array<{ id: string; name: string }>;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const known = new Set(props.options.map((o) => o.id));
  const orphans = props.selected.filter((id) => !known.has(id));
  const toggle = (id: string) =>
    props.onChange(
      props.selected.includes(id)
        ? props.selected.filter((x) => x !== id)
        : [...props.selected, id],
    );

  return (
    <div className="grid gap-1.5">
      <p className="text-sm">
        {props.label}{' '}
        <span className="text-muted-foreground text-xs">
          {props.selected.length ? `(${props.selected.length})` : '(all)'}
        </span>
      </p>
      <div className="border-border/60 grid max-h-44 gap-1 overflow-y-auto rounded-lg border p-2">
        {props.options.length === 0 && orphans.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('None yet.')}</p>
        ) : null}
        {props.options.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-primary size-4"
              checked={props.selected.includes(option.id)}
              onChange={() => toggle(option.id)}
            />
            {option.name}
          </label>
        ))}
        {orphans.map((id) => (
          <label key={id} className="text-muted-foreground flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked onChange={() => toggle(id)} />
            {t('Unavailable item')}
          </label>
        ))}
      </div>
    </div>
  );
}
