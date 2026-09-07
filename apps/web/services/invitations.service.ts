import { apiClient } from './api-client';

export interface InvitationPreview {
  companyName: string;
  companySlug: string;
  email: string;
  roles: Array<{ key: string; name: string }>;
  expiresAt: string;
  /** True when the address already has an account — sign in rather than register. */
  accountExists: boolean;
}

export interface AcceptedInvitation {
  companyId: string;
  companySlug: string;
  companyName: string;
  companyUserId: string;
  email: string;
  roles: Array<{ key: string; name: string }>;
  accountCreated: boolean;
}

/**
 * The public half of the invitation flow.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN GOES IN THE BODY, NEVER IN A URL WE CONTROL
 * ---------------------------------------------------------------------------
 *
 * The link a recipient clicks is a FRONTEND url carrying `?token=…`, which is
 * unavoidable — it has to survive being pasted into a chat window. But that is
 * as far as it travels: the browser reads it, posts it in a request body, and
 * the API never sees it in a path. A token in an API URL is written to access
 * logs, proxy logs and the `Referer` header of every subsequent request.
 *
 * For the same reason the token is never put into TanStack Query keys, React
 * state that outlives the page, or a log line.
 *
 * `anonymous: true` on both: the recipient may have no account at all, and
 * attaching a stale bearer token from a previous user would make `accept`
 * refuse with an email mismatch.
 */
export const invitationsService = {
  preview: (token: string, signal?: AbortSignal) =>
    apiClient.post<InvitationPreview>(
      '/invitations/preview',
      { token },
      { anonymous: true, signal },
    ),

  /**
   * `fullName` and `password` are required only when the address has no
   * account; the server decides, because it is the only side that knows.
   *
   * When the address DOES have an account the caller must already be signed in
   * as it, so this one is deliberately not anonymous — see `useAcceptInvitation`.
   */
  accept: (input: { token: string; fullName?: string; password?: string }, authenticated = false) =>
    apiClient.post<AcceptedInvitation>('/invitations/accept', input, {
      anonymous: !authenticated,
    }),
};
