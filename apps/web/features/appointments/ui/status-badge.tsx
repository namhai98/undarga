import { Badge } from '@/components/ui/badge';
import type { AppointmentStatus } from '@/services/appointments.service';
import { STATUS_LABEL } from '../model/appointment-display';

const VARIANT: Partial<Record<AppointmentStatus, 'default' | 'secondary' | 'destructive' | 'outline'>> = {
  CONFIRMED: 'default',
  IN_PROGRESS: 'default',
  COMPLETED: 'secondary',
  CANCELLED: 'outline',
  NO_SHOW: 'destructive',
};

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  return <Badge variant={VARIANT[status] ?? 'secondary'}>{STATUS_LABEL[status]}</Badge>;
}
