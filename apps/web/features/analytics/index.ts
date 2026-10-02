/**
 * The analytics feature's public surface: the dashboard and reports.
 *
 * Read-only. Nothing in this slice writes business data. (The notification log
 * moved to `features/notifications`.)
 */
export { analyticsKeys, useDashboard, useReport } from './api/use-analytics';

export { DashboardSummary } from './ui/dashboard-summary';
export { ReportsView } from './ui/reports-view';
