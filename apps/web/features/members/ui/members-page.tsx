'use client';

import { Check, Copy, Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { errorText, selectClass } from '@/lib/form';
import type { CreatedInvitation, Member, MemberRole } from '@/services/members.service';
import { RolesCard } from './roles-card';
import {
  useInvitations,
  useInvite,
  useMemberRoles,
  useMembers,
  useRemoveMember,
  useRevokeInvitation,
  useSetMemberRoles,
} from '../api/use-members';
import { useT } from '@/lib/i18n';

/**
 * Who can sign in to this company, and what each may do.
 *
 * The server enforces the rules — not yourself, not the owner, nothing beyond
 * your own access — and this screen only hides controls that would certainly
 * be refused. When the server refuses anyway, its reason is shown.
 */
export function MembersPage() {
  const t = useT();
  const canRead = useCan('member:read');
  const canInvite = useCan('member:invite');
  const canReadRoles = useCan('role:read');

  if (!canRead) {
    return (
      <p role="alert" className="text-sm">
        {t('You do not have permission to see members.')}
      </p>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-xl font-semibold">{t('Members and roles')}</h1>
        <p className="text-muted-foreground text-sm">
          {t('People who can sign in to this company. A role decides what they can see and do.')}
        </p>
      </div>
      <MemberList />
      {canInvite ? <InviteCard /> : null}
      {canReadRoles ? <RolesCard /> : null}
    </div>
  );
}

function MemberList() {
  const t = useT();
  const members = useMembers();
  const roles = useMemberRoles();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Members')}</CardTitle>
      </CardHeader>
      <CardContent>
        {members.isPending ? <Skeleton className="h-24 w-full" aria-busy="true" /> : null}
        {members.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t('Could not load members.')} {t(errorText(members.error))}
          </p>
        ) : null}
        {members.data ? (
          <ul className="divide-border/40 grid divide-y">
            {members.data.items.map((m) => (
              <MemberRow key={m.id} member={m} roles={roles.data?.items ?? []} />
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MemberRow({ member, roles }: { member: Member; roles: MemberRole[] }) {
  const t = useT();
  const canWrite = useCan('member:write');
  const canRemove = useCan('member:remove');
  const setRoles = useSetMemberRoles();
  const remove = useRemoveMember();
  const [confirming, setConfirming] = useState(false);
  const locked = member.isYou || member.isOwner;
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const error = setRoles.error ?? remove.error;
  const label = member.name ?? member.email ?? 'Member';

  return (
    <li className="grid gap-2 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid">
          <span className="font-medium">
            {label}
            {member.isYou ? (
              <span className="text-muted-foreground font-normal"> {t('(you)')}</span>
            ) : null}
          </span>
          {member.email && member.name ? (
            <span className="text-muted-foreground text-xs">{member.email}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {member.isOwner ? <Badge>{t('Owner')}</Badge> : null}
          {member.status !== 'ACTIVE' ? <Badge variant="secondary">{member.status}</Badge> : null}
          <span className="text-muted-foreground">
            {member.roles.map((r) => r.name).join(', ') || t('No role')}
          </span>
          {canWrite && !locked && roles.length > 0 && !choosing ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('Change roles of {label}', { label })}
              onClick={() => {
                setChosen(new Set(member.roles.map((r) => r.key)));
                setChoosing(true);
              }}
            >
              {t('Roles')}
            </Button>
          ) : null}
          {canRemove && !locked ? (
            confirming ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member.id)}
                >
                  {t('Remove {label}', { label })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  {t('Keep')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={t('Remove {label}', { label })}
                onClick={() => setConfirming(true)}
              >
                {t('Remove')}
              </Button>
            )
          ) : null}
        </div>
      </div>
      {choosing ? (
        <fieldset className="border-border/60 grid gap-2 rounded-lg border p-3">
          <legend className="px-1 text-xs font-medium">{t('Roles of {label}', { label })}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {roles.map((r) => (
              <label key={r.key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={t('{name} for {label}', { name: r.name, label })}
                  checked={chosen.has(r.key)}
                  onChange={(e) =>
                    setChosen((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(r.key);
                      else next.delete(r.key);
                      return next;
                    })
                  }
                />
                {r.name}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={chosen.size === 0 || setRoles.isPending}
              onClick={() =>
                setRoles.mutate(
                  { memberId: member.id, roleKeys: [...chosen] },
                  { onSuccess: () => setChoosing(false) },
                )
              }
            >
              {t('Save roles')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setChoosing(false)}>
              {t('Cancel')}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {t(errorText(error))}
        </p>
      ) : null}
    </li>
  );
}

function InviteCard() {
  const t = useT();
  const roles = useMemberRoles();
  const invitations = useInvitations(true);
  const invite = useInvite();
  const revoke = useRevokeInvitation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('');
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const items = roles.data?.items ?? [];
  const chosen = role || items.find((r) => r.key === 'RECEPTIONIST')?.key || items[0]?.key || '';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    try {
      const result = await invite.mutateAsync({ email: email.trim(), roleKeys: [chosen] });
      setCreated(result);
      setEmail('');
    } catch {
      // Shown below.
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('Invite someone')}</CardTitle>
        <CardDescription>
          {t(
            'You get a one-time link to send them yourself. It is shown once and expires after a few days.',
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => void submit(e)}>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">{t('Email')}</Label>
            <Input
              id="invite-email"
              type="email"
              required
              className="w-64"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">{t('Role')}</Label>
            <select
              id="invite-role"
              className={selectClass}
              value={chosen}
              onChange={(e) => setRole(e.target.value)}
            >
              {items.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" disabled={invite.isPending || !email.trim() || !chosen}>
            {invite.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('Create invitation')}
          </Button>
        </form>
        {invite.error ? (
          <p role="alert" className="text-destructive text-sm">
            {t(errorText(invite.error))}
          </p>
        ) : null}
        {created ? <InviteLink invitation={created} /> : null}

        {invitations.data && invitations.data.items.length > 0 ? (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">{t('Waiting to be accepted')}</h3>
            <ul className="grid gap-2">
              {invitations.data.items.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>
                    {i.email}{' '}
                    <span className="text-muted-foreground">
                      · {i.roles.map((r) => r.name).join(', ')} {t('· expires')}{' '}
                      {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    aria-label={t('Cancel the invitation for {email}', { email: i.email })}
                    onClick={() => revoke.mutate(i.id)}
                  >
                    {t('Cancel invitation')}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InviteLink({ invitation }: { invitation: CreatedInvitation }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const link =
    invitation.acceptUrl ??
    `${typeof window === 'undefined' ? '' : window.location.origin}/invitations/accept?token=${encodeURIComponent(invitation.token)}`;

  return (
    <div role="status" className="border-border/60 grid gap-2 rounded-lg border p-3 text-sm">
      <p>
        {t('Send this link to')} <strong>{invitation.email}</strong>. {t('It is shown only now.')}
      </p>
      <div className="flex gap-2">
        <Input
          readOnly
          value={link}
          aria-label={t('Invitation link')}
          onFocus={(e) => e.target.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? t('Copied') : t('Copy')}
        </Button>
      </div>
    </div>
  );
}
