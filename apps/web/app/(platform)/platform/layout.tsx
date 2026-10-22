'use client';

import { PlatformShell } from '@/features/platform';

/**
 * The operator console's shell.
 *
 * A route group of its own, outside `(app)`, because it is a different
 * application with a different session: it must not inherit `RequireSession`,
 * the staff app bar, or the company switcher. Sharing any of those would mean
 * sharing the staff token store, and the two would log each other out.
 */
export default function PlatformLayout({ children }: LayoutProps<'/platform'>) {
  return <PlatformShell>{children}</PlatformShell>;
}
