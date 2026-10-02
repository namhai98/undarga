'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { PriceBreakdown } from '@/components/price-breakdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** What the server says about a code for one basket. Same shape on both APIs. */
export interface PromotionPreview {
  valid: boolean;
  reason: string | null;
  message: string | null;
  originalMinor: string;
  discountMinor: string;
  finalMinor: string;
  currencyCode: string;
  promotion: { name: string; code: string } | null;
}

/**
 * A promotion-code box with an Apply button and the server's price preview.
 *
 * The preview is advisory: the booking request carries only the code, and the
 * API re-checks it and recomputes the price inside the booking transaction.
 * `onApplied` receives the normalised code once the server accepts it, and
 * `null` when it is removed or rejected, so the caller never sends a code that
 * was not previewed as valid.
 *
 * Callers remount it (via `key`) whenever the basket changes, which drops any
 * stale preview.
 */
export function PromotionCodeField(props: {
  id: string;
  validate: (code: string) => Promise<PromotionPreview>;
  onApplied: (code: string | null) => void;
  disabled?: boolean;
}) {
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [preview, setPreview] = useState<PromotionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setPending(true);
    setError(null);
    try {
      const result = await props.validate(trimmed);
      setPreview(result);
      props.onApplied(result.valid && result.promotion ? result.promotion.code : null);
      if (!result.valid) setError(result.message ?? 'This code cannot be used for this booking.');
    } catch {
      setPreview(null);
      props.onApplied(null);
      setError('Could not check this code. Try again.');
    } finally {
      setPending(false);
    }
  };

  const clear = () => {
    setCode('');
    setPreview(null);
    setError(null);
    props.onApplied(null);
  };

  const applied = preview?.valid ? preview : null;

  return (
    <div className="grid gap-2">
      <Label htmlFor={props.id}>Promotion code</Label>
      <div className="flex gap-2">
        <Input
          id={props.id}
          value={code}
          maxLength={48}
          autoComplete="off"
          className="uppercase"
          disabled={props.disabled || pending || !!applied}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${props.id}-error` : undefined}
          onChange={(e) => {
            setCode(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void apply();
            }
          }}
        />
        {applied ? (
          <Button type="button" variant="outline" onClick={clear}>
            <X aria-hidden /> Remove
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={props.disabled || pending || !code.trim()}
            onClick={() => void apply()}
          >
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Apply
          </Button>
        )}
      </div>
      {error ? (
        <p id={`${props.id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {applied ? (
        <div className="bg-muted/40 rounded-lg p-3">
          <PriceBreakdown
            originalMinor={applied.originalMinor}
            discountMinor={applied.discountMinor}
            finalMinor={applied.finalMinor}
            currencyCode={applied.currencyCode}
            discountLabel={applied.promotion?.name}
          />
          <p className="text-muted-foreground mt-2 text-xs">
            The final price is confirmed when the booking is made.
          </p>
        </div>
      ) : null}
    </div>
  );
}
