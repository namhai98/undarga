'use client';

import { Loader2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import type {
  ProviderChannelView,
  ProviderStatus,
  SaveProviderInput,
} from '@/services/notifications.service';
import {
  useNotificationProviders,
  useRemoveNotificationProvider,
  useSaveNotificationProvider,
  useVerifyNotificationProvider,
} from '../api/use-notifications';
import {
  CHANNEL_LABEL,
  notificationErrorMessage,
  providerLabel,
} from '../model/notification-display';

const CONNECTION_LABEL: Record<ProviderStatus, string> = {
  UNVERIFIED: 'Not checked',
  CONNECTED: 'Connected',
  FAILED: 'Not working',
};

const ACTIVE_LABEL: Record<ProviderChannelView['active'], string> = {
  company: 'Your account',
  platform: 'Platform account',
  none: 'Not configured',
};

/**
 * Who sends each channel.
 *
 * By default the platform's account sends everything. A company may connect
 * its own SendGrid (email) or Twilio (SMS) account instead. Secrets are
 * write-only: once saved, only the last four characters are ever shown.
 *
 * Seeing this needs `settings:read`. Checking a connection needs
 * `settings:write`. Connecting, changing or removing an account needs
 * `settings:write` and `settings:billing:write` — the owner, by default — because it
 * decides whose account speaks to the company's customers.
 */
export function NotificationProviders() {
  const providers = useNotificationProviders();
  const canVerify = useCan('settings:write');
  const canBilling = useCan('settings:billing:write');
  const canManage = canVerify && canBilling;

  if (providers.isPending) return <Skeleton className="h-60 w-full" aria-busy="true" />;
  if (providers.error || !providers.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load providers</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="grid gap-4" aria-label="Notification providers">
      <p className="text-muted-foreground max-w-prose text-sm">
        Messages go out through the platform&apos;s email and SMS accounts unless you connect your
        own. A channel with no provider sends nothing.
      </p>
      {!providers.data.companyAccountsAvailable ? (
        <Alert role="status">
          <AlertTitle>Own accounts are not available</AlertTitle>
          <AlertDescription>
            This server has no encryption key for stored credentials, so your own provider accounts
            cannot be connected yet.
          </AlertDescription>
        </Alert>
      ) : null}
      {providers.data.channels.map((view) => (
        <ChannelCard
          key={view.channel}
          view={view}
          canVerify={canVerify}
          canManage={canManage && providers.data.companyAccountsAvailable}
        />
      ))}
    </section>
  );
}

function ChannelCard({
  view,
  canVerify,
  canManage,
}: {
  view: ProviderChannelView;
  canVerify: boolean;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const verify = useVerifyNotificationProvider();
  const remove = useRemoveNotificationProvider();
  const company = view.company;
  const channel = view.channel === 'PUSH' ? null : view.channel;

  const check = async () => {
    if (!channel) return;
    setMessage(null);
    try {
      const result = await verify.mutateAsync(channel);
      setMessage(
        result.company?.status === 'CONNECTED'
          ? { ok: true, text: 'The provider accepted the credentials.' }
          : {
              ok: false,
              text: result.company?.lastError ?? 'The provider refused the credentials.',
            },
      );
    } catch (caught) {
      setMessage({
        ok: false,
        text: notificationErrorMessage(caught, 'Could not check the connection.'),
      });
    }
  };

  const disconnect = async () => {
    if (!channel) return;
    setMessage(null);
    try {
      await remove.mutateAsync(channel);
      setMessage({ ok: true, text: 'Disconnected. The platform account is used again.' });
    } catch (caught) {
      setMessage({ ok: false, text: notificationErrorMessage(caught, 'Could not disconnect.') });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{CHANNEL_LABEL[view.channel]}</CardTitle>
          <Badge variant={view.active === 'none' ? 'secondary' : 'default'}>
            {ACTIVE_LABEL[view.active]}
          </Badge>
        </div>
        <CardDescription>Platform provider: {providerLabel(view.platformProvider)}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {view.channel === 'PUSH' ? (
          <p className="text-muted-foreground">
            Push needs the app to register customers&apos; devices, which it does not do yet.
            Nothing is sent by push.
          </p>
        ) : null}

        {company ? (
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Your account</dt>
            <dd>
              {providerLabel(company.provider)}
              {company.isEnabled ? '' : ' (switched off)'}
            </dd>
            <dt className="text-muted-foreground">Connection</dt>
            <dd>
              <Badge variant={company.status === 'FAILED' ? 'destructive' : 'secondary'}>
                {CONNECTION_LABEL[company.status]}
              </Badge>
              {company.lastError ? (
                <span className="text-destructive ml-2 text-xs">{company.lastError}</span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">
              {company.provider === 'sendgrid' ? 'API key' : 'Auth token'}
            </dt>
            <dd className="font-mono text-xs" aria-label="Stored secret, masked">
              {company.secretHint}
            </dd>
            {Object.entries(company.settings)
              .filter(([key]) => key !== 'webhookPublicKey')
              .map(([key, value]) => (
                <SettingRow key={key} name={key} value={value} />
              ))}
            {company.provider === 'sendgrid' ? (
              <>
                <dt className="text-muted-foreground">Delivery receipts</dt>
                <dd>
                  {company.settings.webhookPublicKey
                    ? 'Signed events on'
                    : 'Off — no verification key'}
                </dd>
              </>
            ) : null}
            {company.receiptUrl && company.provider === 'sendgrid' ? (
              <>
                <dt className="text-muted-foreground">Event Webhook URL</dt>
                <dd className="font-mono text-xs break-all">{company.receiptUrl}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {message ? (
          <Alert
            variant={message.ok ? 'default' : 'destructive'}
            role={message.ok ? 'status' : 'alert'}
          >
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}

        {channel && editing ? (
          <ProviderForm
            channel={channel}
            view={view}
            onDone={(text) => {
              setEditing(false);
              setMessage({ ok: true, text });
            }}
            onCancel={() => setEditing(false)}
          />
        ) : null}

        {channel && !editing ? (
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {company
                  ? 'Edit account'
                  : `Connect your own ${channel === 'EMAIL' ? 'SendGrid' : 'Twilio'} account`}
              </Button>
            ) : null}
            {company && canVerify ? (
              <Button
                size="sm"
                variant="outline"
                disabled={verify.isPending}
                onClick={() => void check()}
              >
                {verify.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Check connection
              </Button>
            ) : null}
            {company && canManage ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={remove.isPending}
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

const SETTING_LABEL: Record<string, string> = {
  fromAddress: 'From address',
  fromName: 'From name',
  accountSid: 'Account SID',
  fromNumber: 'From number',
  messagingServiceSid: 'Messaging Service',
};

function SettingRow({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{SETTING_LABEL[name] ?? name}</dt>
      <dd className="break-all">{value}</dd>
    </>
  );
}

function ProviderForm({
  channel,
  view,
  onDone,
  onCancel,
}: {
  channel: 'EMAIL' | 'SMS';
  view: ProviderChannelView;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const save = useSaveNotificationProvider();
  const existing = view.company;
  const settings = existing?.settings ?? {};
  const [secret, setSecret] = useState('');
  const [isEnabled, setIsEnabled] = useState(existing?.isEnabled ?? true);
  const [fields, setFields] = useState<Record<string, string>>({ ...settings });
  const [error, setError] = useState<string | null>(null);
  const field = (name: string) => fields[name] ?? '';
  const set = (name: string) => (event: { target: { value: string } }) =>
    setFields((current) => ({ ...current, [name]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const optional = (name: string) => (field(name).trim() ? field(name).trim() : undefined);
    const config: SaveProviderInput =
      channel === 'EMAIL'
        ? {
            provider: 'sendgrid',
            isEnabled,
            ...(secret.trim() ? { secrets: { apiKey: secret.trim() } } : {}),
            settings: {
              fromAddress: field('fromAddress').trim(),
              fromName: optional('fromName'),
              webhookPublicKey: optional('webhookPublicKey'),
            },
          }
        : {
            provider: 'twilio',
            isEnabled,
            ...(secret.trim() ? { secrets: { authToken: secret.trim() } } : {}),
            settings: {
              accountSid: field('accountSid').trim(),
              fromNumber: optional('fromNumber'),
              messagingServiceSid: optional('messagingServiceSid'),
            },
          };
    try {
      await save.mutateAsync({ channel, config });
      setSecret('');
      onDone('Saved. Check the connection to confirm it works.');
    } catch (caught) {
      setError(notificationErrorMessage(caught, 'Could not save the account.'));
    }
  };

  const id = (name: string) => `provider-${channel}-${name}`;
  const secretLabel = channel === 'EMAIL' ? 'SendGrid API key' : 'Twilio auth token';

  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => void submit(e)}
      aria-label={`${CHANNEL_LABEL[channel]} account`}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={id('secret')}>{secretLabel}</Label>
        <Input
          id={id('secret')}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={existing ? `Stored (${existing.secretHint}) — leave blank to keep` : ''}
          required={!existing}
        />
      </div>
      {channel === 'EMAIL' ? (
        <>
          <TextField
            id={id('fromAddress')}
            label="From address"
            value={field('fromAddress')}
            onChange={set('fromAddress')}
            type="email"
            required
          />
          <TextField
            id={id('fromName')}
            label="From name (optional)"
            value={field('fromName')}
            onChange={set('fromName')}
          />
          <TextField
            id={id('webhookPublicKey')}
            label="Event Webhook verification key (optional, enables delivery receipts)"
            value={field('webhookPublicKey')}
            onChange={set('webhookPublicKey')}
          />
        </>
      ) : (
        <>
          <TextField
            id={id('accountSid')}
            label="Account SID"
            value={field('accountSid')}
            onChange={set('accountSid')}
            required
          />
          <TextField
            id={id('fromNumber')}
            label="From number (e.g. +97699112233)"
            value={field('fromNumber')}
            onChange={set('fromNumber')}
          />
          <TextField
            id={id('messagingServiceSid')}
            label="Messaging Service SID (instead of a number)"
            value={field('messagingServiceSid')}
            onChange={set('messagingServiceSid')}
          />
        </>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isEnabled}
          onChange={(e) => setIsEnabled(e.target.checked)}
        />
        Send {CHANNEL_LABEL[channel].toLowerCase()} through this account
      </label>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Save account
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={props.onChange}
        required={props.required}
        autoComplete="off"
      />
    </div>
  );
}
