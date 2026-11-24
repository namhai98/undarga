'use client';

import { ArrowLeft, Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { PlatformCompanyUser } from '@/services/platform.service';
import { usePlatformCompany, usePlatformCompanyUsers } from '../api/use-platform';

const PAGE_SIZE = 25;

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/** The shared UserStatus enum, as the API's `status` filter accepts it. */
const MEMBERSHIP_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED', 'LOCKED'] as const;
type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Everyone who can sign in to one company.
 *
 * COMPANY USERS, not customers: the people who bought the product, which is who
 * an operator supports. The API selects no credential, session or MFA field,
 * and nothing on this screen asks for one.
 */
export function PlatformCompanyUsers({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<MembershipStatus | ''>('');
  const [offset, setOffset] = useState(0);

  const company = usePlatformCompany(companyId);
  const users = usePlatformCompanyUsers(companyId, {
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(status ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  const total = users.data?.total ?? 0;
  const items = users.data?.items ?? [];
  const filtered = Boolean(search.trim() || status);

  const changeFilter = (apply: () => void) => {
    apply();
    setOffset(0);
  };

  return (
    <section className="grid gap-4">
      <Link
        href={`/platform/companies/${companyId}`}
        className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} -ml-2 w-fit`}
      >
        <ArrowLeft aria-hidden className="size-4" />
        {company.data ? company.data.displayName : 'Back to company'}
      </Link>

      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-muted-foreground text-sm">
          {users.isPending
            ? 'Loading…'
            : `${total} ${total === 1 ? 'person' : 'people'} can sign in to this company. Not its customers.`}
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="user-search">Search</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute top-2 left-2.5 size-4"
            />
            <Input
              id="user-search"
              value={search}
              placeholder="Email or name"
              className="pl-8"
              onChange={(e) => changeFilter(() => setSearch(e.target.value))}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="user-status">Membership</Label>
          <select
            id="user-status"
            value={status}
            className={selectClass}
            onChange={(e) => changeFilter(() => setStatus(e.target.value as MembershipStatus | ''))}
          >
            <option value="">All</option>
            {MEMBERSHIP_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {users.error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not load users</AlertTitle>
          <AlertDescription>The company may have been deleted. Please try again.</AlertDescription>
        </Alert>
      ) : null}

      {users.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading users…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!users.isPending && !users.error && items.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">
            {filtered ? 'Nobody matches those filters' : 'Nobody has joined yet'}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {filtered
              ? 'Try widening the search.'
              : 'The owner appears here once they accept their invitation.'}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? <CompanyUserTable users={items} /> : null}

      {total > PAGE_SIZE ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || users.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || users.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {users.isFetching ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Shared by this page and the preview on the company detail screen. */
export function CompanyUserTable({ users }: { users: PlatformCompanyUser[] }) {
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
          <tr>
            <th scope="col" className="py-2 pr-3 font-medium">Email</th>
            <th scope="col" className="py-2 pr-3 font-medium">Name</th>
            <th scope="col" className="py-2 pr-3 font-medium">Roles</th>
            <th scope="col" className="py-2 pr-3 font-medium">Membership</th>
            <th scope="col" className="py-2 font-medium">Last sign-in</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.membershipId} className="border-border/40 border-b last:border-0">
              <td className="py-2 pr-3">
                {user.email}
                {user.isOwner ? (
                  <Badge variant="secondary" className="ml-2">
                    owner
                  </Badge>
                ) : null}
              </td>
              <td className="text-muted-foreground py-2 pr-3">{user.fullName ?? '—'}</td>
              <td className="text-muted-foreground py-2 pr-3">{user.roles.join(', ') || '—'}</td>
              <td className="py-2 pr-3">
                <Badge variant={user.membershipStatus === 'ACTIVE' ? 'default' : 'secondary'}>
                  {user.membershipStatus.toLowerCase()}
                </Badge>
              </td>
              <td className="text-muted-foreground py-2 whitespace-nowrap">
                {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : 'Never'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
