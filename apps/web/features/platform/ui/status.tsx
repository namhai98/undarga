import type { CompanyStatus } from '@/services/platform.service';

/**
 * How a company status reads on screen.
 *
 * `CANCELED` is labelled "Disabled" because that is what it means to the person
 * reading the console: the company is switched off. The API value is never
 * relabelled — a filter sends `CANCELED` and the audit trail records
 * `platform.company.canceled` — so the label is presentation and the vocabulary
 * stays single.
 */
export const COMPANY_STATUS_LABEL: Record<CompanyStatus, string> = {
  PENDING_SETUP: 'Pending setup',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  CANCELED: 'Disabled',
};

export function statusTone(status: CompanyStatus): 'default' | 'secondary' | 'destructive' {
  if (status === 'ACTIVE') return 'default';
  if (status === 'SUSPENDED') return 'destructive';
  return 'secondary';
}
