import { apiClient } from './api-client';

export interface Member {
  id: string;
  userAccountId: string;
  email: string | null;
  name: string | null;
  status: string;
  isOwner: boolean;
  /** The signed-in user's own row: nobody changes their own access. */
  isYou: boolean;
  roles: Array<{ key: string; name: string }>;
  joinedAt: string | null;
}

export interface MemberRole {
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

export interface Invitation {
  id: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  roles: Array<{ key: string; name: string }>;
  expiresAt: string;
  createdAt: string;
}

export interface CreatedInvitation extends Invitation {
  /** Shown once, never again: the server keeps only a hash of it. */
  token: string;
  acceptUrl?: string;
}

/**
 * Member and role administration. These routes are not under
 * `/companies/:id`, so the company travels in the header.
 */
export const membersService = {
  list: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: Member[] }>('/members', { companyId, signal }),

  roles: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: MemberRole[] }>('/members/roles', { companyId, signal }),

  setRoles: (companyId: string, memberId: string, roleKeys: string[]) =>
    apiClient.put<Member>(`/members/${memberId}/roles`, { roleKeys }, { companyId }),

  remove: (companyId: string, memberId: string) =>
    apiClient.delete<void>(`/members/${memberId}`, { companyId }),

  invitations: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: Invitation[]; total: number }>('/members/invitations', {
      companyId,
      signal,
      query: { status: 'live', limit: 100 },
    }),

  invite: (companyId: string, email: string, roleKeys: string[]) =>
    apiClient.post<CreatedInvitation>('/members/invitations', { email, roleKeys }, { companyId }),

  revokeInvitation: (companyId: string, invitationId: string) =>
    apiClient.delete<void>(`/members/invitations/${invitationId}`, { companyId }),
};

export interface RoleInput {
  name: string;
  description?: string | null;
  permissions: string[];
}

/** Roles of the company's own. Built-in roles are read-only. */
export const rolesService = {
  permissions: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<{ items: string[] }>('/members/permissions', { companyId, signal }),

  create: (companyId: string, input: RoleInput) =>
    apiClient.post<MemberRole>('/members/roles', input, { companyId }),

  update: (companyId: string, key: string, input: Partial<RoleInput>) =>
    apiClient.patch<MemberRole>(`/members/roles/${key}`, input, { companyId }),

  remove: (companyId: string, key: string) =>
    apiClient.delete<void>(`/members/roles/${key}`, { companyId }),
};
