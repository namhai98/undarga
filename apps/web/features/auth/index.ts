/**
 * The auth feature's public surface.
 *
 * Everything outside this slice imports from here and nowhere else — reaching
 * into `ui/` or `api/` couples callers to internals (`features/README.md`).
 */
export { SessionProvider, SessionContext, type SessionState, type SessionStatus } from './model/session-provider';
export { useSession } from './model/use-session';
export { useCan, usePermissions } from './model/use-permissions';

export { authKeys, useMe, useSessionContext } from './api/use-session-query';
export { useLogin, destinationFor, isSafeReturnPath } from './api/use-login';
export { useLogout } from './api/use-logout';
export { useSwitchCompany } from './api/use-switch-company';
export { useInvitationPreview, useAcceptInvitation } from './api/use-invitation';

export { LoginForm } from './ui/login-form';
export { RequireSession } from './ui/require-session';
export { AcceptInvitationForm } from './ui/accept-invitation-form';
export { CompanySwitcher } from './ui/company-switcher';
export { SignOutButton } from './ui/sign-out-button';
export { Can } from './ui/can';
