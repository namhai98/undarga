'use client';

import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/services/api-error';
import { usePlatformLogin, usePlatformLogout, usePlatformSession } from '../api/use-platform';

const NAV = [
  { href: '/platform', label: 'Dashboard' },
  { href: '/platform/companies', label: 'Companies' },
  { href: '/platform/audit-logs', label: 'Audit logs' },
] as const;

/**
 * The operator console's shell, and its sign-in gate.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A REDIRECT, NOT A SECURITY BOUNDARY
 * ---------------------------------------------------------------------------
 *
 * It exists so an operator sees a login form instead of a page that 401s on
 * every tile. The actual boundary is `@PlatformOnly` on the API, which rejects
 * a staff token at the AUDIENCE check before any permission is read. Nothing
 * here is load-bearing (`docs/ARCHITECTURE-RULES.md`, rule 3).
 *
 * ---------------------------------------------------------------------------
 * A RELOAD SIGNS YOU OUT, AND THE SCREEN SAYS SO
 * ---------------------------------------------------------------------------
 *
 * There is no platform refresh endpoint, and the refresh cookie is scoped to
 * the staff path. So the console's session lives in memory for fifteen minutes
 * and a page reload ends it. That is a limitation worth stating on the form
 * rather than one worth discovering.
 */
export function PlatformShell({ children }: { children: ReactNode }) {
  const signedIn = usePlatformSession();
  const pathname = usePathname();
  const logout = usePlatformLogout();

  if (!signedIn) return <PlatformLogin />;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border/60 border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <div className="flex items-baseline gap-4">
            <span className="text-sm font-semibold">Undarga Platform</span>
            <nav className="flex gap-3">
              {NAV.map((item) => {
                const active =
                  item.href === '/platform'
                    ? pathname === '/platform'
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`text-sm ${
                      active ? 'font-medium underline underline-offset-4' : 'text-muted-foreground'
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <Button
            variant="ghost"
            size="sm"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            {logout.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Sign out
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}

function PlatformLogin() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const login = usePlatformLogin();

  const submit = async () => {
    setError(null);
    try {
      await login.mutateAsync({ email: email.trim(), password });
    } catch (caught) {
      // One message for every rejection. Distinguishing "no such operator" from
      // "wrong password" tells an attacker which half they got right, and an
      // operator account is a key to every tenant on the platform.
      // A fetch that never reached the server throws a TypeError, not an
      // ApiError — that is an outage, not a wrong password.
      setError(
        !(caught instanceof ApiError) || caught.status >= 500
          ? 'The server is not responding. Try again shortly.'
          : 'Those credentials were not accepted.',
      );
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6">
      <form
        className="grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <header className="grid gap-1">
          <p className="text-muted-foreground text-sm">Undarga</p>
          <h1 className="text-lg font-semibold">Platform console</h1>
          <p className="text-muted-foreground text-sm">
            Operator accounts only. This is separate from your company sign-in.
          </p>
        </header>

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Could not sign in</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="platform-email">Email</Label>
          <Input
            id="platform-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="platform-password">Password</Label>
          <Input
            id="platform-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <Button type="submit" disabled={login.isPending || !email || !password}>
          {login.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Sign in
        </Button>

        <p className="text-muted-foreground text-xs">
          This session is held in memory and ends when the page reloads.
        </p>
      </form>
    </div>
  );
}
