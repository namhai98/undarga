'use client';

import { BranchList } from '@/features/branches';

import { CompanyBrandingCard, CompanyDetails } from '@/features/companies';
import { useT } from '@/lib/i18n';

/** The business itself: company details and its branches. */
export default function SettingsPage() {
  const t = useT();
  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">{t('Business settings')}</h1>
      <CompanyDetails />
      <CompanyBrandingCard />
      <BranchList />
    </div>
  );
}
