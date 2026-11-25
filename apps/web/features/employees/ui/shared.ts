import type { EmployeeStatus } from '@/services/employees.service';

export { errorText, selectClass } from '@/lib/form';

export const STATUS_LABEL: Record<EmployeeStatus, string> = {
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  INACTIVE: 'Inactive',
  TERMINATED: 'Terminated',
};
