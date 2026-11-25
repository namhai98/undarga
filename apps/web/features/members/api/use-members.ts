'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import { membersService, rolesService, type RoleInput } from '@/services/members.service';

export const memberKeys = {
  all: (companyId: string) => ['members', companyId] as const,
  list: (companyId: string) => [...memberKeys.all(companyId), 'list'] as const,
  roles: (companyId: string) => [...memberKeys.all(companyId), 'roles'] as const,
  invitations: (companyId: string) => [...memberKeys.all(companyId), 'invitations'] as const,
};

export function useMembers() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: memberKeys.list(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => membersService.list(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useMemberRoles() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: memberKeys.roles(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => membersService.roles(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useInvitations(enabled: boolean) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: memberKeys.invitations(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => membersService.invitations(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId) && enabled,
  });
}

function useInvalidate() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: memberKeys.all(activeCompanyId!) });
}

export function useSetMemberRoles() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ memberId, roleKeys }: { memberId: string; roleKeys: string[] }) =>
      membersService.setRoles(activeCompanyId!, memberId, roleKeys),
    onSuccess: invalidate,
  });
}

export function useRemoveMember() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (memberId: string) => membersService.remove(activeCompanyId!, memberId),
    onSuccess: invalidate,
  });
}

export function useInvite() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ email, roleKeys }: { email: string; roleKeys: string[] }) =>
      membersService.invite(activeCompanyId!, email, roleKeys),
    onSuccess: invalidate,
  });
}

export function useRevokeInvitation() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (invitationId: string) =>
      membersService.revokeInvitation(activeCompanyId!, invitationId),
    onSuccess: invalidate,
  });
}

export function usePermissionCatalog(enabled = true) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: [...memberKeys.all(activeCompanyId ?? 'none'), 'permissions'],
    queryFn: ({ signal }) => rolesService.permissions(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId) && enabled,
  });
}

export function useRoleChanges() {
  const { activeCompanyId } = useSession();
  const invalidate = useInvalidate();
  return {
    create: useMutation({
      mutationFn: (input: RoleInput) => rolesService.create(activeCompanyId!, input),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ key, input }: { key: string; input: Partial<RoleInput> }) =>
        rolesService.update(activeCompanyId!, key, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (key: string) => rolesService.remove(activeCompanyId!, key),
      onSuccess: invalidate,
    }),
  };
}
