'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout } from '../api/use-logout';
import { useT } from '@/lib/i18n';

export function SignOutButton() {
  const t = useT();
  const logout = useLogout();

  return (
    <Button variant="ghost" size="sm" disabled={logout.isPending} onClick={() => logout.mutate()}>
      {logout.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {t('Sign out')}
    </Button>
  );
}
