import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { getT } from '@/lib/i18n/server';

export default async function NotFound() {
  const t = await getT();
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">{t('Page not found')}</h1>
      <p className="text-muted-foreground text-sm">
        {t('This page does not exist, or you do not have access to it.')}
      </p>
      <div>
        {/* shadcn v4 is built on Base UI, which has no `asChild`. Styling the
            Link with `buttonVariants` keeps the anchor semantics without
            reaching for Base UI's `render` prop for something this simple. */}
        <Link href="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          {t('Back to start')}
        </Link>
      </div>
    </main>
  );
}
