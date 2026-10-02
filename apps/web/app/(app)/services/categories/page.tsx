'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { CategoryManager } from '@/features/catalog';

/**
 * Category administration, on its own route rather than a tab.
 *
 * Categories are configured occasionally and services are edited constantly;
 * putting them side by side would make the rarer job compete for attention with
 * the common one.
 */
export default function ServiceCategoriesPage() {
  return (
    <div className="grid gap-4">
      <Link
        href="/services"
        className={buttonVariants({ variant: 'ghost', size: 'sm' }) + ' -ml-2 w-fit'}
      >
        ← All services
      </Link>
      <CategoryManager />
    </div>
  );
}
