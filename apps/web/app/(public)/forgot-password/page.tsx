import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/features/auth';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Forgot password — Undarga') };
}

export default async function ForgotPasswordPage() {
  const t = await getT();
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Forgot your password?')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('Enter the email you sign in with and we will send you a link to set a new one.')}
        </p>
      </div>
      <ForgotPasswordForm />
    </div>
  );
}
