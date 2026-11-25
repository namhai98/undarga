'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBranches } from '@/features/branches';
import { useCreateEmployee } from '../api/use-employees';
import { errorText, selectClass } from './shared';
import { useT } from '@/lib/i18n';

/**
 * The first step of adding someone: a name and where they work. Services and
 * working hours follow on their own page, which this opens on success.
 */
export function AddEmployeeForm({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  const router = useRouter();
  const branches = useBranches();
  const create = useCreateEmployee();
  const [displayName, setDisplayName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [branchId, setBranchId] = useState('');
  const items = branches.data?.items ?? [];
  const chosenBranch = branchId || (items.length === 1 ? items[0]!.id : '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const employee = await create.mutateAsync({
        displayName: displayName.trim(),
        ...(chosenBranch ? { branchIds: [chosenBranch] } : {}),
        ...(jobTitle.trim() ? { profile: { jobTitle: jobTitle.trim() } } : {}),
      });
      router.push(`/staff/${employee.id}`);
    } catch {
      // Shown below.
    }
  };

  return (
    <form
      aria-label={t('Add employee')}
      className="border-border/60 grid gap-3 rounded-lg border p-4 sm:grid-cols-3"
      onSubmit={(e) => void submit(e)}
    >
      <div className="grid gap-1.5">
        <Label htmlFor="new-emp-name">{t('Name')}</Label>
        <Input
          id="new-emp-name"
          value={displayName}
          maxLength={128}
          required
          autoFocus
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-emp-title">{t('Job title (optional)')}</Label>
        <Input
          id="new-emp-title"
          value={jobTitle}
          maxLength={96}
          onChange={(e) => setJobTitle(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="new-emp-branch">{t('Branch')}</Label>
        <select
          id="new-emp-branch"
          className={selectClass}
          value={chosenBranch}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <option value="">{t('Choose later')}</option>
          {items.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      {create.error ? (
        <p role="alert" className="text-destructive text-sm sm:col-span-3">
          {t(errorText(create.error, 'Could not add the employee. Please try again.'))}
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" disabled={create.isPending || !displayName.trim()}>
          {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t('Add and set up')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}
