'use client';

import { Badge } from '@/components/ui/badge';
import type { AppointmentStatus } from '@/services/appointments.service';
import { STATUS_LABEL } from '../model/appointment-display';
import { useT } from '@/lib/i18n';

const VARIANT: Partial<
  Record<AppointmentStatus, 'default' | 'secondary' | 'destructive' | 'outline'>
> = {
  CONFIRMED: 'default',
  IN_PROGRESS: 'default',
  COMPLETED: 'secondary',
  CANCELLED: 'outline',
  NO_SHOW: 'destructive',
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const t = useT();
  return <Badge variant={VARIANT[status] ?? 'secondary'}>{t(STATUS_LABEL[status])}</Badge>;
}
