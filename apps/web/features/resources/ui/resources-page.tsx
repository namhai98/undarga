'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useBranches } from '@/features/branches';
import { ApiError } from '@/services/api-error';
import type {
  Resource,
  ResourceKind,
  ResourceWindow,
  UnavailabilityReason,
} from '@/services/resources.service';
import {
  useAddResourceUnavailability,
  useCreateResource,
  useCreateResourceType,
  useRemoveResourceUnavailability,
  useResourceTypes,
  useResourceUnavailability,
  useResourceWindows,
  useResources,
  useSaveResourceWindows,
} from '../api/use-resources';

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND_LABEL: Record<ResourceKind, string> = {
  ROOM: 'Room',
  CHAIR: 'Chair',
  EQUIPMENT: 'Equipment',
  MEETING_ROOM: 'Meeting room',
  TREATMENT_ROOM: 'Treatment room',
  SERVICE_BAY: 'Service bay',
  OTHER: 'Other',
};
const REASON_LABEL: Record<UnavailabilityReason, string> = {
  MAINTENANCE: 'Maintenance',
  OUT_OF_SERVICE: 'Out of service',
  RESERVED: 'Reserved',
  OTHER: 'Other',
};

function message(error: unknown, fallback: string): string {
  if (
    error instanceof ApiError &&
    ['VALIDATION_FAILED', 'CONFLICT', 'RESOURCE_NOT_FOUND', 'ENTITLEMENT_LIMIT_REACHED'].includes(
      error.code,
    )
  ) {
    return error.message;
  }
  if (error instanceof ApiError && error.code === 'PERMISSION_DENIED')
    return 'You do not have permission to change resources.';
  return fallback;
}

/**
 * Rooms, chairs and equipment, and when each can be booked.
 *
 * Each resource is used by one appointment at a time. To offer two parallel
 * treatments, add two rooms of the type — a service needing "a treatment
 * room" takes any free one. Weekly windows narrow a resource to part of the
 * branch's hours; unavailable periods (maintenance…) block it entirely.
 */
export function ResourcesPage() {
  const canRead = useCan('resource:read');
  const canWrite = useCan('resource:write');
  const branches = useBranches();
  const [branchId, setBranchId] = useState('');
  const resources = useResources(branchId);

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You do not have permission to see resources.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Rooms and equipment</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          A service that needs a room or a piece of equipment is only offered when one is free. Each
          resource takes one appointment at a time — add several of a type for parallel bookings.
        </p>
      </header>

      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="resources-branch">Branch</Label>
        <select
          id="resources-branch"
          className={selectClass}
          value={branchId}
          onChange={(e) => setBranchId(e.target.value)}
        >
          <option value="">All branches</option>
          {(branches.data?.items ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      {canWrite ? <NewResource defaultBranchId={branchId} /> : null}

      {resources.isPending ? <Skeleton className="h-32 w-full" aria-busy="true" /> : null}
      {resources.data && resources.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">No rooms or equipment yet.</p>
      ) : null}
      <div className="grid gap-3">
        {(resources.data?.items ?? []).map((r) => (
          <ResourceCard key={r.id} resource={r} canWrite={canWrite} />
        ))}
      </div>
    </div>
  );
}

function NewResource({ defaultBranchId }: { defaultBranchId: string }) {
  const branches = useBranches();
  const types = useResourceTypes();
  const createType = useCreateResourceType();
  const create = useCreateResource();
  const [branchId, setBranchId] = useState(defaultBranchId);
  const [typeId, setTypeId] = useState('');
  const [name, setName] = useState('');
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeKind, setNewTypeKind] = useState<ResourceKind>('ROOM');
  const [error, setError] = useState<string | null>(null);

  const addType = async () => {
    setError(null);
    try {
      const key = newTypeName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
      const type = await createType.mutateAsync({
        key: key.length >= 2 ? key : `type-${Date.now()}`,
        name: newTypeName.trim(),
        kind: newTypeKind,
      });
      setTypeId(type.id);
      setNewTypeName('');
    } catch (caught) {
      setError(message(caught, 'Could not add the type.'));
    }
  };

  const add = async () => {
    setError(null);
    try {
      await create.mutateAsync({
        branchId: branchId || defaultBranchId,
        resourceTypeId: typeId,
        name: name.trim(),
      });
      setName('');
    } catch (caught) {
      setError(message(caught, 'Could not add the resource.'));
    }
  };

  const effectiveBranch = branchId || defaultBranchId;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a room or equipment</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="resource-branch">Branch</Label>
            <select
              id="resource-branch"
              className={selectClass}
              value={effectiveBranch}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">Select…</option>
              {(branches.data?.items ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="resource-type">Type</Label>
            <select
              id="resource-type"
              className={selectClass}
              value={typeId}
              onChange={(e) => setTypeId(e.target.value)}
            >
              <option value="">Select…</option>
              {(types.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({KIND_LABEL[t.kind]})
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="resource-name">Name</Label>
            <Input
              id="resource-name"
              value={name}
              maxLength={128}
              placeholder="Room 1"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Button
            disabled={!effectiveBranch || !typeId || !name.trim() || create.isPending}
            onClick={() => void add()}
          >
            {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Add
          </Button>
          <span className="text-muted-foreground px-2 text-sm">or a new type:</span>
          <Input
            aria-label="New type name"
            className="w-44"
            value={newTypeName}
            placeholder="Treatment room"
            onChange={(e) => setNewTypeName(e.target.value)}
          />
          <select
            aria-label="New type kind"
            className={selectClass}
            value={newTypeKind}
            onChange={(e) => setNewTypeKind(e.target.value as ResourceKind)}
          >
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!newTypeName.trim() || createType.isPending}
            onClick={() => void addType()}
          >
            Add type
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ResourceCard({ resource, canWrite }: { resource: Resource; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{resource.name}</CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{resource.resourceTypeName}</Badge>
            <Badge variant={resource.status === 'ACTIVE' ? 'default' : 'destructive'}>
              {resource.status === 'ACTIVE'
                ? 'Active'
                : resource.status === 'OUT_OF_SERVICE'
                  ? 'Out of service'
                  : 'Inactive'}
            </Badge>
            <Button size="sm" variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Close' : 'Availability'}
            </Button>
          </div>
        </div>
        {!resource.isBookable ? <CardDescription>Not bookable.</CardDescription> : null}
      </CardHeader>
      {open ? (
        <CardContent className="grid gap-4">
          <Windows id={resource.id} canWrite={canWrite} />
          <Blocked id={resource.id} canWrite={canWrite} />
        </CardContent>
      ) : null}
    </Card>
  );
}

function Windows({ id, canWrite }: { id: string; canWrite: boolean }) {
  const windows = useResourceWindows(id);
  if (windows.isPending) return <Skeleton className="h-20 w-full" />;
  return (
    <WindowsForm
      key={JSON.stringify(windows.data?.rules ?? [])}
      id={id}
      saved={windows.data?.rules ?? []}
      canWrite={canWrite}
    />
  );
}

function WindowsForm({
  id,
  saved,
  canWrite,
}: {
  id: string;
  saved: ResourceWindow[];
  canWrite: boolean;
}) {
  const save = useSaveResourceWindows();
  const [rules, setRules] = useState<ResourceWindow[]>(saved);
  const [note, setNote] = useState<string | null>(null);
  const invalid = rules.some((r) => !(r.endsAt > r.startsAt));

  const submit = async () => {
    setNote(null);
    try {
      await save.mutateAsync({ id, rules });
      setNote('Saved.');
    } catch (caught) {
      setNote(message(caught, 'Could not save.'));
    }
  };

  return (
    <section className="grid gap-2" aria-label="Weekly availability">
      <h3 className="text-sm font-medium">When it can be booked</h3>
      <p className="text-muted-foreground text-xs">
        {rules.length === 0
          ? 'No windows: it follows the branch’s opening hours.'
          : 'Only inside these windows (and within opening hours).'}
      </p>
      <ul className="grid gap-1">
        {rules.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
            <select
              aria-label="Day"
              className={selectClass}
              value={r.dayOfWeek}
              disabled={!canWrite}
              onChange={(e) =>
                setRules(
                  rules.map((x, j) => (j === i ? { ...x, dayOfWeek: Number(e.target.value) } : x)),
                )
              }
            >
              {DAYS.map((d, n) => (
                <option key={d} value={n}>
                  {d}
                </option>
              ))}
            </select>
            <Input
              aria-label="From"
              type="time"
              className="w-28"
              value={r.startsAt}
              disabled={!canWrite}
              onChange={(e) =>
                setRules(rules.map((x, j) => (j === i ? { ...x, startsAt: e.target.value } : x)))
              }
            />
            <span>–</span>
            <Input
              aria-label="Until"
              type="time"
              className="w-28"
              value={r.endsAt}
              disabled={!canWrite}
              onChange={(e) =>
                setRules(rules.map((x, j) => (j === i ? { ...x, endsAt: e.target.value } : x)))
              }
            />
            {canWrite ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remove window"
                onClick={() => setRules(rules.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={rules.length >= 28}
            onClick={() =>
              setRules([...rules, { dayOfWeek: 1, startsAt: '09:00', endsAt: '17:00' }])
            }
          >
            Add window
          </Button>
          <Button size="sm" disabled={invalid || save.isPending} onClick={() => void submit()}>
            Save windows
          </Button>
          {invalid ? (
            <span className="text-destructive text-sm">Each window must end after it starts.</span>
          ) : null}
          {note ? (
            <span role="status" className="text-sm">
              {note}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Blocked({ id, canWrite }: { id: string; canWrite: boolean }) {
  const list = useResourceUnavailability(id);
  const add = useAddResourceUnavailability();
  const remove = useRemoveResourceUnavailability();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<UnavailabilityReason>('MAINTENANCE');
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<
    Array<{ appointmentId: string; appointmentNumber: string }>
  >([]);

  const submit = async (allowConflicts = false) => {
    setError(null);
    try {
      await add.mutateAsync({
        id,
        startsAt: new Date(from).toISOString(),
        endsAt: new Date(to).toISOString(),
        reason,
        ...(allowConflicts ? { allowConflicts: true } : {}),
      });
      setFrom('');
      setTo('');
      setConflicts([]);
    } catch (caught) {
      setConflicts(
        caught instanceof ApiError && caught.code === 'CONFLICT'
          ? ((caught.details?.appointments as typeof conflicts | undefined) ?? [])
          : [],
      );
      setError(message(caught, 'Could not block this period.'));
    }
  };

  return (
    <section className="grid gap-2" aria-label="Unavailable periods">
      <h3 className="text-sm font-medium">Unavailable periods</h3>
      <ul className="grid gap-1 text-sm">
        {(list.data?.items ?? []).map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums">
              {new Date(b.startsAt).toLocaleString()} → {new Date(b.endsAt).toLocaleString()}
            </span>
            <Badge variant="secondary">{REASON_LABEL[b.reason]}</Badge>
            {canWrite ? (
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remove period"
                disabled={remove.isPending}
                onClick={() => void remove.mutateAsync({ id, unavailabilityId: b.id })}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </li>
        ))}
        {list.data && list.data.items.length === 0 ? (
          <li className="text-muted-foreground">None.</li>
        ) : null}
      </ul>
      {canWrite ? (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            aria-label="Unavailable from"
            type="datetime-local"
            className="w-52"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Input
            aria-label="Unavailable until"
            type="datetime-local"
            className="w-52"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          <select
            aria-label="Reason"
            className={selectClass}
            value={reason}
            onChange={(e) => setReason(e.target.value as UnavailabilityReason)}
          >
            {Object.entries(REASON_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!from || !to || new Date(to) <= new Date(from) || add.isPending}
            onClick={() => void submit()}
          >
            Block period
          </Button>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-destructive grid gap-1 text-sm">
          <p>{error}</p>
          {conflicts.length ? (
            <>
              <p>Booked: {conflicts.map((c) => c.appointmentNumber).join(', ')}</p>
              <div>
                <Button size="sm" variant="destructive" onClick={() => void submit(true)}>
                  Block anyway (appointments stay booked)
                </Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
