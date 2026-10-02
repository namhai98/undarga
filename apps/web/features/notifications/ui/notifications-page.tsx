'use client';

import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useNotificationSettings } from '../api/use-notifications';
import { NotificationHistory } from './notification-history';
import { NotificationSettingsForm } from './notification-settings-form';
import { NotificationTemplates } from './notification-templates';

type Tab = 'history' | 'templates' | 'settings';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'history', label: 'History' },
  { id: 'templates', label: 'Templates' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Notifications: what was sent, the wording, and the switches.
 *
 * All three need `settings:read`; changing anything needs `settings:write`,
 * and the forms render disabled without it. The settings response also
 * carries the catalog of message types, which the history uses for labels.
 */
export function NotificationsPage() {
  const canRead = useCan('settings:read');
  const [tab, setTab] = useState<Tab>('history');
  const settings = useNotificationSettings();

  if (!canRead) {
    return (
      <Alert role="status">
        <AlertTitle>Not available</AlertTitle>
        <AlertDescription>You do not have permission to see notifications.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Notifications</h1>
        <p className="text-muted-foreground text-sm">
          Email, SMS and push messages to customers about their bookings and gift cards.
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Notifications"
        className="border-border/60 flex gap-1 border-b"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`notif-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`notif-panel-${t.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? 'border-primary font-medium'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`notif-panel-${tab}`} aria-labelledby={`notif-tab-${tab}`}>
        {tab === 'history' ? <NotificationHistory catalog={settings.data?.catalog ?? []} /> : null}
        {tab === 'templates' ? <NotificationTemplates /> : null}
        {tab === 'settings' ? (
          settings.isPending ? (
            <Skeleton className="h-60 w-full" aria-busy="true" />
          ) : settings.error || !settings.data ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not load settings</AlertTitle>
              <AlertDescription>Please try again.</AlertDescription>
            </Alert>
          ) : (
            <NotificationSettingsForm settings={settings.data} />
          )
        ) : null}
      </div>
    </div>
  );
}
