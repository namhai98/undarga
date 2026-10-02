'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useCan } from '@/features/auth';
import type { NotificationChannel, NotificationSettings } from '@/services/notifications.service';
import { useUpdateNotificationSettings } from '../api/use-notifications';
import {
  CHANNEL_LABEL,
  REMINDER_PRESETS,
  notificationErrorMessage,
  offsetLabel,
} from '../model/notification-display';

const CHANNELS: NotificationChannel[] = ['EMAIL', 'SMS', 'PUSH'];
const KEY: Record<NotificationChannel, 'email' | 'sms' | 'push'> = {
  EMAIL: 'email',
  SMS: 'sms',
  PUSH: 'push',
};
const MAX_REMINDERS = 4;

/**
 * Company-wide switches: channels, reminder timing, and which channels each
 * kind of message goes out on by default.
 *
 * Edited as a draft and saved in one request, so a half-made change never
 * reaches customers. A viewer without `settings:write` sees the same form,
 * disabled.
 */
export function NotificationSettingsForm({ settings }: { settings: NotificationSettings }) {
  const canWrite = useCan('settings:write');
  const save = useUpdateNotificationSettings();
  const [channels, setChannels] = useState(settings.channels);
  const [remindersEnabled, setRemindersEnabled] = useState(settings.reminders.enabled);
  const [offsets, setOffsets] = useState<number[]>(settings.reminders.offsetsMinutes);
  const [eventChannels, setEventChannels] = useState(settings.eventChannels);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const presets = [...new Set([...REMINDER_PRESETS, ...offsets])].sort((a, b) => b - a);
  const disabled = !canWrite || save.isPending;

  const toggleOffset = (minutes: number) =>
    setOffsets((current) =>
      current.includes(minutes) ? current.filter((m) => m !== minutes) : [...current, minutes],
    );

  const toggleEventChannel = (type: string, channel: NotificationChannel) =>
    setEventChannels((current) => {
      const list = current[type] ?? [];
      return {
        ...current,
        [type]: list.includes(channel) ? list.filter((c) => c !== channel) : [...list, channel],
      };
    });

  const submit = async () => {
    setMessage(null);
    try {
      await save.mutateAsync({
        channels,
        reminders: { enabled: remindersEnabled, offsetsMinutes: offsets },
        eventChannels,
      });
      setMessage({ ok: true, text: 'Notification settings saved.' });
    } catch (caught) {
      setMessage({
        ok: false,
        text: notificationErrorMessage(caught, 'Could not save the settings.'),
      });
    }
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Channels</CardTitle>
          <CardDescription>
            A channel switched off here sends nothing at all, whatever a template or a customer’s
            preference says.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6">
          {CHANNELS.map((channel) => (
            <Check
              key={channel}
              label={CHANNEL_LABEL[channel]}
              checked={channels[KEY[channel]]}
              disabled={disabled}
              onChange={(value) => setChannels((c) => ({ ...c, [KEY[channel]]: value }))}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appointment reminders</CardTitle>
          <CardDescription>
            Sent to the customer before each confirmed or pending appointment. A booking made after
            a reminder’s moment skips that reminder rather than sending it late.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Check
            label="Send reminders"
            checked={remindersEnabled}
            disabled={disabled}
            onChange={setRemindersEnabled}
          />
          <fieldset className="grid gap-2" disabled={disabled || !remindersEnabled}>
            <legend className="text-muted-foreground mb-1 text-xs">
              When (up to {MAX_REMINDERS})
            </legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {presets.map((minutes) => (
                <Check
                  key={minutes}
                  label={offsetLabel(minutes)}
                  checked={offsets.includes(minutes)}
                  disabled={
                    disabled ||
                    !remindersEnabled ||
                    (!offsets.includes(minutes) && offsets.length >= MAX_REMINDERS)
                  }
                  onChange={() => toggleOffset(minutes)}
                />
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default notification preferences</CardTitle>
          <CardDescription>
            Which channels each message goes out on. Customers can still turn a channel off for
            themselves; push reaches nobody until an app registers devices.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground border-border/60 border-b text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Message
                </th>
                {CHANNELS.map((channel) => (
                  <th key={channel} scope="col" className="py-2 pr-3 font-medium">
                    {CHANNEL_LABEL[channel]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {settings.catalog.map((type) => (
                <tr key={type.type} className="border-border/40 border-b last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {type.label}
                  </th>
                  {CHANNELS.map((channel) => (
                    <td key={channel} className="py-2 pr-3">
                      <input
                        type="checkbox"
                        aria-label={`${type.label} by ${CHANNEL_LABEL[channel]}`}
                        checked={(eventChannels[type.type] ?? []).includes(channel)}
                        disabled={disabled || !channels[KEY[channel]]}
                        onChange={() => toggleEventChannel(type.type, channel)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {message ? (
        <Alert
          variant={message.ok ? 'default' : 'destructive'}
          role={message.ok ? 'status' : 'alert'}
        >
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}

      {canWrite ? (
        <div>
          <Button disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Save settings
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          You can view these settings but not change them.
        </p>
      )}
    </div>
  );
}

function Check(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}
