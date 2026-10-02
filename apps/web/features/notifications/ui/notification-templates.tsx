'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import type {
  NotificationChannel,
  NotificationTemplate,
  NotificationTypeInfo,
  TemplatePreview,
} from '@/services/notifications.service';
import {
  useNotificationTemplates,
  usePreviewTemplate,
  useSaveTemplate,
} from '../api/use-notifications';
import { CHANNEL_LABEL, notificationErrorMessage } from '../model/notification-display';

const CHANNELS: NotificationChannel[] = ['EMAIL', 'SMS', 'PUSH'];
const SMS_MAX = 480;
const textareaClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 min-h-32 w-full rounded-lg border px-2.5 py-2 text-sm outline-none focus-visible:ring-3';

interface Editing {
  type: NotificationTypeInfo;
  channel: NotificationChannel;
  existing: NotificationTemplate | null;
}

/**
 * The company's own wording, per message and channel.
 *
 * Every cell is either the platform default or the company's template. An
 * inactive template means "use the default" — to stop a message, switch its
 * channel off in Settings. Variables are filled from the booking; the preview
 * renders on the server with sample values, through the same code that sends.
 */
export function NotificationTemplates() {
  const templates = useNotificationTemplates();
  const canWrite = useCan('settings:write');
  const [editing, setEditing] = useState<Editing | null>(null);

  if (templates.isPending) {
    return <Skeleton className="h-40 w-full" aria-busy="true" />;
  }
  if (templates.error || !templates.data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Could not load templates</AlertTitle>
        <AlertDescription>Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { items, catalog } = templates.data;
  const find = (type: string, channel: NotificationChannel) =>
    items.find((t) => t.type === type && t.channel === channel) ?? null;

  return (
    <section className="grid gap-4" aria-label="Templates">
      {editing ? (
        <TemplateEditor
          key={`${editing.type.type}:${editing.channel}`}
          editing={editing}
          readOnly={!canWrite}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <div className="overflow-x-auto">
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
            {catalog.map((type) => (
              <tr key={type.type} className="border-border/40 border-b last:border-0">
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  {type.label}
                </th>
                {CHANNELS.map((channel) => {
                  const existing = find(type.type, channel);
                  return (
                    <td key={channel} className="py-2 pr-3">
                      <button
                        type="button"
                        className="flex items-center gap-2 hover:underline"
                        aria-label={`${type.label} ${CHANNEL_LABEL[channel]} template`}
                        onClick={() => setEditing({ type, channel, existing })}
                      >
                        {existing ? (
                          <Badge variant={existing.isActive ? 'default' : 'secondary'}>
                            {existing.isActive ? 'Custom' : 'Custom · off'}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Default</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TemplateEditor({
  editing,
  readOnly,
  onClose,
}: {
  editing: Editing;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { type, channel, existing } = editing;
  const fallback = type.defaults[channel];
  const [subject, setSubject] = useState(existing?.subject ?? fallback.subject ?? '');
  const [body, setBody] = useState(existing?.body ?? fallback.body);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);

  const save = useSaveTemplate();
  const render = usePreviewTemplate();
  const hasSubject = channel !== 'SMS';

  const runPreview = async () => {
    setError(null);
    try {
      setPreview(
        await render.mutateAsync({
          type: type.type,
          channel,
          subject: hasSubject ? subject : null,
          body,
        }),
      );
    } catch (caught) {
      setPreview(null);
      setError(notificationErrorMessage(caught, 'Could not preview this template.'));
    }
  };

  const submit = async () => {
    setError(null);
    setSaved(false);
    try {
      await save.mutateAsync({
        id: existing?.id ?? null,
        type: type.type,
        channel,
        subject: hasSubject ? subject : null,
        body,
        isActive,
      });
      setSaved(true);
    } catch (caught) {
      setError(notificationErrorMessage(caught, 'Could not save the template.'));
    }
  };

  return (
    <section
      aria-label={`${type.label} — ${CHANNEL_LABEL[channel]}`}
      className="border-border/60 grid gap-4 rounded-lg border p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">
            {type.label} — {CHANNEL_LABEL[channel]}
          </h3>
          <p className="text-muted-foreground text-xs">
            {existing
              ? 'The company’s own wording.'
              : 'Using the default. Saving creates your own version.'}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>

      {hasSubject ? (
        <div className="grid gap-1.5">
          <Label htmlFor="template-subject">{channel === 'PUSH' ? 'Title' : 'Subject'}</Label>
          <Input
            id="template-subject"
            value={subject}
            maxLength={256}
            disabled={readOnly}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <Label htmlFor="template-body">Message</Label>
        <textarea
          id="template-body"
          className={textareaClass}
          value={body}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">Insert:</span>
          {type.variables.map((name) => (
            <button
              key={name}
              type="button"
              disabled={readOnly}
              className="bg-muted hover:bg-muted/70 rounded px-1.5 py-0.5 font-mono text-xs"
              onClick={() => setBody((b) => `${b}{{${name}}}`)}
            >
              {`{{${name}}}`}
            </button>
          ))}
          {channel === 'SMS' ? (
            <span
              className={`ml-auto text-xs tabular-nums ${body.length > SMS_MAX ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {body.length}/{SMS_MAX}
            </span>
          ) : null}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isActive}
          disabled={readOnly}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Active — when off, the default wording is used instead
      </label>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <Alert role="status">
          <AlertDescription>Template saved.</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={render.isPending}
          onClick={() => void runPreview()}
        >
          {render.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Preview
        </Button>
        {!readOnly ? (
          <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Save template
          </Button>
        ) : null}
      </div>

      {preview ? (
        <div className="bg-muted/40 grid gap-1 rounded-md p-3" aria-label="Preview">
          <p className="text-muted-foreground text-xs">Preview with sample values</p>
          {preview.subject ? <p className="text-sm font-medium">{preview.subject}</p> : null}
          <pre className="font-sans text-sm whitespace-pre-wrap">{preview.body}</pre>
        </div>
      ) : null}
    </section>
  );
}
