import type { Metadata } from 'next';
import { ResetPasswordForm } from '@/features/auth';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Set a new password — Undarga') };
}

/** Opened from the reset email. The token is single-use; it only ever goes back to the API. */
export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const t = await getT();
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : undefined;
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">{t('Set a new password')}</h1>
      <ResetPasswordForm token={token} />
    </div>
  );
}
