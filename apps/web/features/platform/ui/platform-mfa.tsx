'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/services/api-error';
import { platformService } from '@/services/platform.service';

const mfaKey = ['platform', 'mfa'] as const;

/**
 * Two-factor authentication for the signed-in operator.
 *
 * The secret is shown once, while setting up; it cannot be shown again. An
 * operator who loses their phone is reset with the server-side script
 * (`scripts/platform-mfa.ts`), not from here — this screen cannot replace a
 * working second factor, by design.
 */
export function PlatformMfaCard() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: mfaKey,
    queryFn: ({ signal }) => platformService.mfaStatus(signal),
  });
  const setup = useMutation({ mutationFn: () => platformService.mfaSetup() });
  const confirm = useMutation({
    mutationFn: (code: string) => platformService.mfaConfirm(code),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mfaKey }),
  });
  const [code, setCode] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirm.mutate(code);
  };
  const problem = (error: unknown) =>
    error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Two-factor authentication</CardTitle>
        <CardDescription>
          A code from an authenticator app at every sign-in. Required in production for every
          operator: this console reaches every company.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {status.data?.enrolled ? (
          <p>
            <Badge>On</Badge>{' '}
            <span className="text-muted-foreground">Your account asks for a code at sign-in.</span>
          </p>
        ) : status.data && !status.data.available ? (
          <p className="text-destructive">
            The server cannot store a second factor yet (SECRETS_ENCRYPTION_KEY is not set).
          </p>
        ) : status.data ? (
          setup.data ? (
            <div className="grid gap-3">
              <p>
                Scan the code with an authenticator app (Google Authenticator, 1Password, Authy…).
                On a phone, tap the link; otherwise type the key in. It is shown only now.
              </p>
              <QrCode value={setup.data.otpauthUri} />
              <a className="break-all underline" href={setup.data.otpauthUri}>
                Open in authenticator app
              </a>
              <code className="bg-muted rounded px-2 py-1 font-mono tracking-wider break-all">
                {setup.data.secret.replace(/(.{4})/g, '$1 ').trim()}
              </code>
              <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
                <div className="grid gap-1.5">
                  <Label htmlFor="mfa-confirm-code">Code from the app</Label>
                  <Input
                    id="mfa-confirm-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="w-32"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>
                <Button type="submit" size="sm" disabled={code.length !== 6 || confirm.isPending}>
                  {confirm.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Turn on
                </Button>
              </form>
              {confirm.error ? (
                <p role="alert" className="text-destructive">
                  {problem(confirm.error)}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-2">
              <p>
                <Badge variant="secondary">Off</Badge>{' '}
                <span className="text-muted-foreground">
                  Set it up now — production will not let you in without it.
                </span>
              </p>
              <div>
                <Button
                  type="button"
                  size="sm"
                  disabled={setup.isPending}
                  onClick={() => setup.mutate()}
                >
                  {setup.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  Set up two-factor authentication
                </Button>
              </div>
              {setup.error ? (
                <p role="alert" className="text-destructive">
                  {problem(setup.error)}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The otpauth URI as a QR code, drawn in the browser: the secret never goes
 * to a third-party QR service. A data: URL, which the CSP allows for images.
 */
function QrCode({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(value, { margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then((url) => {
        if (live) setSrc(url);
      })
      .catch(() => {
        if (live) setSrc(null);
      });
    return () => {
      live = false;
    };
  }, [value]);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- generated locally, a data: URL
    <img
      src={src}
      alt="QR code for your authenticator app"
      width={192}
      height={192}
      className="rounded border bg-white p-1"
    />
  ) : null;
}
