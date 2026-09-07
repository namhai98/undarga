'use client';

import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSwitchCompany } from '../api/use-switch-company';
import { useSession } from '../model/use-session';

/**
 * Pick which company to work in.
 *
 * Rendered as a list rather than a dropdown because it is also the
 * `/select-company` screen, where it is the entire point of the page. A
 * compact trigger belongs in the app bar later, over the same hook.
 *
 * Hidden entirely for a single-company user: a picker offering one option is
 * furniture.
 */
export function CompanySwitcher() {
  const { memberships, activeCompanyId } = useSession();
  const switchCompany = useSwitchCompany();

  if (memberships.length <= 1) return null;

  return (
    <ul className="grid gap-2">
      {memberships.map((membership) => {
        const isActive = membership.companyId === activeCompanyId;
        const isSwitching =
          switchCompany.isPending && switchCompany.variables?.companyId === membership.companyId;

        return (
          <li key={membership.companyId}>
            <Button
              variant="outline"
              size="lg"
              className="w-full justify-between"
              // Every button is disabled while one switch is in flight: two
              // overlapping switches would each retire the other's session.
              disabled={switchCompany.isPending || isActive}
              onClick={() => switchCompany.mutate({ companyId: membership.companyId })}
            >
              <span className="flex flex-col items-start">
                <span className="font-medium">{membership.companyName}</span>
                <span className="text-muted-foreground text-xs">
                  {membership.companySlug}
                  {membership.isOwner ? ' · owner' : ''}
                </span>
              </span>
              {isSwitching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {isActive ? <Check aria-label="Current company" /> : null}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
