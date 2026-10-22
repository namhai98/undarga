/**
 * The platform feature's public surface.
 *
 * Nothing in the staff app imports from here, and nothing here imports the
 * staff session: the console has its own token store and its own API client so
 * the two sessions cannot log each other out.
 */
export {
  platformKeys,
  usePlatformSession,
  usePlatformLogin,
  usePlatformLogout,
  usePlatformDashboard,
  usePlatformCompanies,
  usePlatformCompany,
  usePlatformCompanyUsers,
  usePlatformSubscription,
  useChangeCompanyStatus,
  usePlatformAuditLogs,
} from './api/use-platform';

export { PlatformShell } from './ui/platform-shell';
export { PlatformDashboard } from './ui/platform-dashboard';
export { PlatformCompanyList } from './ui/platform-company-list';
export { PlatformCompanyDetail } from './ui/platform-company-detail';
export { PlatformCompanyUsers } from './ui/platform-company-users';
export { PlatformAuditLog } from './ui/platform-audit-log';
