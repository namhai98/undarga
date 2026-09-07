'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLogout } from '../api/use-logout';

export function SignOutButton() {
  const logout = useLogout();

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={logout.isPending}
      onClick={() => logout.mutate()}
    >
      {logout.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
      Sign out
    </Button>
  );
}
