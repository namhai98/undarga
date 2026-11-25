'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChangePasswordForm, SignOutEverywhere, useSession } from '@/features/auth';
import { useT } from '@/lib/i18n';

/** Your own login: password and sessions. Not the company's settings. */
export default function AccountPage() {
  const t = useT();
  const { user } = useSession();
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Your account')}</h1>
        <p className="text-muted-foreground text-sm">{user?.email}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('Password')}</CardTitle>
          <CardDescription>{t('Changing it signs you out on your other devices.')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('Sessions')}</CardTitle>
          <CardDescription>
            {t(
              'Lost a phone, or signed in on a shared computer? End every session, including this one.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SignOutEverywhere />
        </CardContent>
      </Card>
    </div>
  );
}
