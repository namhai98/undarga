import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground text-sm">
        This page does not exist, or you do not have access to it.
      </p>
      <div>
        {/* shadcn v4 is built on Base UI, which has no `asChild`. Styling the
            Link with `buttonVariants` keeps the anchor semantics without
            reaching for Base UI's `render` prop for something this simple. */}
        <Link href="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Back to start
        </Link>
      </div>
    </main>
  );
}
