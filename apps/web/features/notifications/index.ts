/**
 * The notifications feature's public surface: history, templates, settings,
 * and a customer's channel preferences.
 *
 * Nothing here sends a message. Messages come from business events on the
 * server; these screens show what happened and set the rules.
 */
export {
  notificationKeys,
  useNotifications,
  useNotification,
  useNotificationStats,
  useRunNotifications,
  useNotificationSettings,
  useUpdateNotificationSettings,
  useNotificationTemplates,
  useSaveTemplate,
  usePreviewTemplate,
  useCustomerNotificationPreferences,
  useUpdateCustomerNotificationPreferences,
} from './api/use-notifications';

export { NotificationsPage } from './ui/notifications-page';
export { CustomerNotificationPreferences } from './ui/customer-notification-preferences';
