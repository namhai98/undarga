'use client';

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import {
  useCustomerNotificationPreferences,
  useUpdateCustomerNotificationPreferences,
} from '../api/use-notifications';
import { notificationErrorMessage } from '../model/notification-display';

const CHANNELS = [
  { key: 'email', label: 'Email', missing: 'No valid email address on file.' },
  { key: 'sms', label: 'SMS', missing: 'No valid mobile number on file.' },
  { key: 'push', label: 'Push', missing: 'No app device registered.' },
] as const;

/**
 * A customer's channels, on their page. Staff set these when the customer
 * asks; each switch saves on its own. Not rendered without `customer:read`.
 */
export function CustomerNotificationPreferences({ customerId }: { customerId: string }) {
  const canRead = useCan('customer:read');
  const canWrite = useCan('customer:write');
  const preferences = useCustomerNotificationPreferences(customerId, canRead);
  const update = useUpdateCustomerNotificationPreferences(customerId);
  const [error, setError] = useState<string | null>(null);

  if (!canRead) return null;
  const data = preferences.data;

  const toggle = async (key: 'email' | 'sms' | 'push', value: boolean) => {
    setError(null);
    try {
      await update.mutateAsync({ [key]: value });
    } catch (caught) {
      setError(notificationErrorMessage(caught, 'Could not save.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Booking confirmations, reminders and gift-card messages. Company-wide switches still
          apply.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {preferences.isPending ? <Skeleton className="h-16 w-full" /> : null}
        {preferences.error ? (
          <p role="alert" className="text-destructive text-sm">
            Could not load notification preferences.
          </p>
        ) : null}
        {data
          ? CHANNELS.map((channel) => (
              <div key={channel.key} className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={data.enabled[channel.key]}
                    disabled={!canWrite || update.isPending}
                    onChange={(e) => void toggle(channel.key, e.target.checked)}
                  />
                  {channel.label}
                </label>
                {!data.reachable[channel.key] ? (
                  <span className="text-muted-foreground text-xs">{channel.missing}</span>
                ) : null}
              </div>
            ))
          : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
