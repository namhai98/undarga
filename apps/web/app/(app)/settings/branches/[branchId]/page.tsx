import { BranchDetail } from '@/features/branches';

/** One branch. `params` is a Promise in Next 16. */
export default async function BranchPage(props: PageProps<'/settings/branches/[branchId]'>) {
  const { branchId } = await props.params;
  return <BranchDetail branchId={branchId} />;
}
