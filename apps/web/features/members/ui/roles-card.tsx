'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCan, usePermissions } from '@/features/auth';
import { errorText } from '@/lib/form';
import type { MemberRole } from '@/services/members.service';
import { useMemberRoles, usePermissionCatalog, useRoleChanges } from '../api/use-members';
import { useT } from '@/lib/i18n';

/** `customer:write` → group `customer`, action `write`. */
function groups(keys: string[]): Array<[string, string[]]> {
  const map = new Map<string, string[]>();
  for (const key of keys) {
    const [group = key, ...rest] = key.split(':');
    const list = map.get(group) ?? [];
    list.push(rest.join(':') || key);
    map.set(group, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The company's roles. Built-in roles are shown for reference; the company
 * can add its own, choosing only from permissions the editor holds — the
 * server enforces that, and the unavailable boxes are disabled here.
 */
export function RolesCard() {
  const t = useT();
  const canWrite = useCan('role:write');
  const roles = useMemberRoles();
  const [editing, setEditing] = useState<MemberRole | 'new' | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Roles')}</CardTitle>
        <CardDescription>
          {t(
            'A role is a set of permissions. Built-in roles cannot be changed; create your own for anything in between.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <ul className="divide-border/40 grid divide-y">
          {(roles.data?.items ?? []).map((r) => (
            <li key={r.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{r.name}</span>{' '}
                <span className="text-muted-foreground">
                  ·{' '}
                  {r.permissions.length === 1
                    ? t('1 permission')
                    : t('{count} permissions', { count: r.permissions.length })}
                </span>{' '}
                {r.isSystem ? <Badge variant="secondary">{t('Built-in')}</Badge> : null}
              </span>
              {canWrite && !r.isSystem ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  {t('Edit')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canWrite && editing === null ? (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing('new')}>
              {t('Create a role')}
            </Button>
          </div>
        ) : null}
        {editing ? (
          <RoleEditor
            key={editing === 'new' ? 'new' : editing.key}
            role={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function RoleEditor({ role, onDone }: { role: MemberRole | null; onDone: () => void }) {
  const t = useT();
  const catalog = usePermissionCatalog();
  const { permissions: held, isOwner } = usePermissions();
  const { create, update, remove } = useRoleChanges();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [chosen, setChosen] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const busy = create.isPending || update.isPending || remove.isPending;
  const error = create.error ?? update.error ?? remove.error;

  const toggle = (key: string, on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = {
      name: name.trim(),
      description: description.trim() || null,
      permissions: [...chosen].sort(),
    };
    if (role) update.mutate({ key: role.key, input }, { onSuccess: onDone });
    else create.mutate(input, { onSuccess: onDone });
  };

  return (
    <form
      aria-label={role ? t('Edit {name}', { name: role.name }) : 'Create a role'}
      className="border-border/60 grid gap-3 rounded-lg border p-3"
      onSubmit={submit}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="role-name">{t('Role name')}</Label>
          <Input
            id="role-name"
            required
            maxLength={96}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="role-description">{t('Description (optional)')}</Label>
          <Input
            id="role-description"
            maxLength={256}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 font-medium">{t('Permissions')}</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {groups(catalog.data?.items ?? []).map(([group, actions]) => (
            <div key={group} className="grid gap-1">
              <span className="text-muted-foreground text-xs font-medium uppercase">{group}</span>
              {actions.map((action) => {
                const key = `${group}:${action}`;
                const allowed = isOwner || held.has(key);
                return (
                  <label
                    key={key}
                    className="flex items-center gap-2"
                    title={allowed ? undefined : 'You do not hold this permission'}
                  >
                    <input
                      type="checkbox"
                      aria-label={key}
                      checked={chosen.has(key)}
                      disabled={!allowed}
                      onChange={(e) => toggle(key, e.target.checked)}
                    />
                    <span className={allowed ? undefined : 'text-muted-foreground'}>{action}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </fieldset>
      {error ? (
        <p role="alert" className="text-destructive">
          {t(errorText(error))}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !name.trim() || chosen.size === 0}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {role ? t('Save role') : t('Create role')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('Cancel')}
        </Button>
        {role ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive ml-auto"
            disabled={busy}
            onClick={() => remove.mutate(role.key, { onSuccess: onDone })}
          >
            {t('Delete role')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
