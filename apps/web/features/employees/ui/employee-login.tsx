'use client';

import { Check, Copy, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCan } from '@/features/auth';
import { useMemberRoles } from '@/features/members';
import type { EmployeeDetail } from '@/services/employees.service';
import { useEmployeeAccount } from '../api/use-employees';
import { errorText, selectClass } from './shared';
import { useT } from '@/lib/i18n';

/**
 * A login for this member of staff, so they can see their own bookings and
 * request time off. Creates an invitation; they choose their own password.
 */
export function EmployeeLogin({ employee }: { employee: EmployeeDetail }) {
  const t = useT();
  const canInvite = useCan('member:invite');
  const canWrite = useCan('employee:write');
  const roles = useMemberRoles();
  const { link, unlink } = useEmployeeAccount(employee.id);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const items = roles.data?.items ?? [];
  const chosen = role || items.find((r) => r.key === 'EMPLOYEE')?.key || items[0]?.key || '';
  const invitation = link.data?.invitation;
  const inviteLink = invitation
    ? (invitation.acceptUrl ??
      `${typeof window === 'undefined' ? '' : window.location.origin}/invitations/accept?token=${encodeURIComponent(invitation.token)}`)
    : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    link.mutate({ email: email.trim(), roleKeys: [chosen] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Login')}</CardTitle>
        <CardDescription>
          {t('Lets this person sign in to see their own appointments and request time off.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {employee.account ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {employee.account.email ?? t('Invitation sent')}{' '}
              <Badge variant="secondary">
                {employee.account.status === 'PENDING_ACCEPTANCE' ? t('Invited') : t('Can sign in')}
              </Badge>
            </span>
            {canWrite ? (
              confirming ? (
                <span className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={unlink.isPending}
                    onClick={() =>
                      unlink.mutate(undefined, { onSuccess: () => setConfirming(false) })
                    }
                  >
                    {t('Unlink login')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirming(false)}
                  >
                    {t('Keep')}
                  </Button>
                </span>
              ) : (
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                  {t('Unlink')}
                </Button>
              )
            ) : null}
          </div>
        ) : canInvite && canWrite ? (
          <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
            <div className="grid gap-1.5">
              <Label htmlFor="emp-login-email">{t('Their email')}</Label>
              <Input
                id="emp-login-email"
                type="email"
                required
                className="w-64"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="emp-login-role">{t('Role')}</Label>
              <select
                id="emp-login-role"
                className={selectClass}
                value={chosen}
                onChange={(e) => setRole(e.target.value)}
              >
                {items.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" size="sm" disabled={!email.trim() || !chosen || link.isPending}>
              {link.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('Create login')}
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground">
            {t('No login. Ask someone who can invite members.')}
          </p>
        )}

        {inviteLink ? (
          <div role="status" className="border-border/60 grid gap-2 rounded-lg border p-3">
            <p>{t('Send this link to them. It is shown only now.')}</p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={inviteLink}
                aria-label={t('Invitation link')}
                onFocus={(e) => e.target.select()}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard?.writeText(inviteLink).then(() => setCopied(true))
                }
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                {copied ? t('Copied') : t('Copy')}
              </Button>
            </div>
          </div>
        ) : null}
        {(link.error ?? unlink.error) ? (
          <p role="alert" className="text-destructive">
            {t(errorText(link.error ?? unlink.error))}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
