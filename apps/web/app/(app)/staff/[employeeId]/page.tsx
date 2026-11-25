import { EmployeeDetail } from '@/features/employees';

/** One member of staff. `params` is a Promise in Next 16. */
export default async function EmployeeDetailPage(props: PageProps<'/staff/[employeeId]'>) {
  const { employeeId } = await props.params;
  return <EmployeeDetail employeeId={employeeId} />;
}
