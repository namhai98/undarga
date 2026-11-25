import type { Metadata } from 'next';
import { VerifyEmail } from '@/features/auth';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t('Confirm your email — Undarga') };
}

export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  const t = await getT();
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : undefined;
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">{t('Confirm your email')}</h1>
      <VerifyEmail token={token} />
    </div>
  );
}
