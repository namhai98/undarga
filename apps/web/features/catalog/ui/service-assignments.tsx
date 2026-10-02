'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { useEmployees } from '@/features/employees';
import { ApiError } from '@/services/api-error';
import { useService, useServiceAssignments } from '../api/use-catalog';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * Where a service is offered, and who provides it.
 *
 * ---------------------------------------------------------------------------
 * BOTH LISTS ARE THE SAME ROWS THE OTHER SCREENS WRITE
 * ---------------------------------------------------------------------------
 *
 * The employee half writes `employee_service`, which is exactly what the staff
 * screen's "services" list writes from the other direction. One table, two
 * doors — so assigning here and unassigning there are the same operation, and
 * both invalidate both caches.
 *
 * Being assigned to a service does NOT mean the person can provide it at every
 * branch. The availability engine will intersect employee↔branch with
 * service↔branch; this screen only records the two halves.
 */
export function ServiceAssignments({
  serviceId,
  onBack,
}: {
  serviceId: string;
  onBack: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const canWrite = useCan('service:write');
  const service = useService(serviceId);
  const branches = useBranches();
  const employees = useEmployees({ limit: 100, status: 'ACTIVE' });
  const assignments = useServiceAssignments(serviceId);

  const [branchToAdd, setBranchToAdd] = useState('');
  const [employeeToAdd, setEmployeeToAdd] = useState('');

  if (service.isPending) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <span className="sr-only">Loading the service…</span>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (service.error || !service.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load the service</AlertTitle>
        <AlertDescription>It may have been removed.</AlertDescription>
      </Alert>
    );
  }

  const detail = service.data;
  const assignedBranchIds = new Set(detail.branches.map((b) => b.branchId));
  const assignedEmployeeIds = new Set(detail.employees.map((e) => e.employeeId));

  const unassignedBranches = (branches.data?.items ?? []).filter((b) => !assignedBranchIds.has(b.id));
  const unassignedEmployees = (employees.data?.items ?? []).filter(
    (e) => !assignedEmployeeIds.has(e.id),
  );

  /** One place to turn a rejection into a sentence, for four mutations. */
  const run = async (action: Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : fallback);
    }
  };

  return (
    <section className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-4" />
          All services
        </Button>
        <h2 className="text-lg font-semibold">{detail.name}</h2>
        <p className="text-muted-foreground text-sm">
          {detail.durationMin} min
          {detail.totalOccupiedMin !== detail.durationMin
            ? ` · ${detail.totalOccupiedMin} min including buffers`
            : ''}
        </p>
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not update</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3">
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">Offered at</h3>
          <p className="text-muted-foreground text-xs">
            A service with no branch cannot be booked anywhere.
          </p>
        </div>

        {detail.branches.length === 0 ? (
          <p className="text-muted-foreground text-sm">No branches yet.</p>
        ) : (
          <ul className="grid gap-1.5">
            {detail.branches.map((branch) => (
              <li
                key={branch.branchId}
                className="border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  {branch.name ?? branch.branchId}
                  {/* Assigned but withheld — a room being refitted. */}
                  {branch.isAvailable ? null : <Badge variant="secondary">Paused</Badge>}
                </span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={assignments.removeBranch.isPending}
                    onClick={() =>
                      void run(
                        assignments.removeBranch.mutateAsync(branch.branchId),
                        'Could not remove the branch.',
                      )
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canWrite && unassignedBranches.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="add-branch">Add a branch</Label>
              <select
                id="add-branch"
                value={branchToAdd}
                className={selectClass}
                onChange={(e) => setBranchToAdd(e.target.value)}
              >
                <option value="">Choose…</option>
                {unassignedBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              disabled={!branchToAdd || assignments.assignBranch.isPending}
              onClick={() => {
                void run(
                  assignments.assignBranch.mutateAsync(branchToAdd),
                  'Could not add the branch.',
                ).then(() => setBranchToAdd(''));
              }}
            >
              {assignments.assignBranch.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : null}
              Add
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1">
          <h3 className="text-sm font-medium">Provided by</h3>
          <p className="text-muted-foreground text-xs">
            The same assignment the staff screen shows — one record, edited from either side.
          </p>
        </div>

        {detail.employees.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {detail.requiresEmployee
              ? 'Nobody yet. This service needs a member of staff to be bookable.'
              : 'Nobody yet.'}
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {detail.employees.map((employee) => (
              <li
                key={employee.employeeId}
                className="border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2">
                  {employee.displayName ?? employee.employeeId}
                  {employee.employeeStatus && employee.employeeStatus !== 'ACTIVE' ? (
                    <Badge variant="secondary">{employee.employeeStatus.toLowerCase()}</Badge>
                  ) : null}
                </span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={assignments.removeEmployee.isPending}
                    onClick={() =>
                      void run(
                        assignments.removeEmployee.mutateAsync(employee.employeeId),
                        'Could not remove the assignment.',
                      )
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {canWrite && unassignedEmployees.length > 0 ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="add-employee">Add someone</Label>
              <select
                id="add-employee"
                value={employeeToAdd}
                className={selectClass}
                onChange={(e) => setEmployeeToAdd(e.target.value)}
              >
                <option value="">Choose…</option>
                {unassignedEmployees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.displayName}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              disabled={!employeeToAdd || assignments.assignEmployee.isPending}
              onClick={() => {
                void run(
                  assignments.assignEmployee.mutateAsync(employeeToAdd),
                  'Could not add the assignment.',
                ).then(() => setEmployeeToAdd(''));
              }}
            >
              {assignments.assignEmployee.isPending ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : null}
              Add
            </Button>
          </div>
        ) : null}
      </div>

      {detail.resourceRequirements.length > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Needs</h3>
          <ul className="text-muted-foreground grid gap-1 text-sm">
            {detail.resourceRequirements.map((requirement) => (
              <li key={requirement.resourceTypeId}>
                {/* By TYPE, not by specific resource — "a treatment room", not
                    "room 3". Which one is chosen is a booking-time decision. */}
                {requirement.quantity} × {requirement.name ?? requirement.resourceTypeId}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
