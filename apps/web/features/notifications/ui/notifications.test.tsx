import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { CustomerNotificationPreferences } from './customer-notification-preferences';
import { NotificationsPage } from './notifications-page';

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, details } }, status);

const catalog = [
  {
    type: 'appointment.created',
    label: 'Appointment booked',
    variables: ['customerName', 'serviceName', 'appointmentTime'],
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: { subject: 'Your booking', body: 'Hi {{customerName}}' },
      SMS: { body: 'Booked {{serviceName}}' },
      PUSH: { subject: 'Booked', body: '{{serviceName}}' },
    },
  },
  {
    type: 'appointment.reminder',
    label: 'Appointment reminder',
    variables: ['customerName', 'serviceName', 'appointmentTime'],
    defaultChannels: ['EMAIL', 'SMS', 'PUSH'],
    defaults: {
      EMAIL: { subject: 'Reminder', body: 'Reminder {{serviceName}}' },
      SMS: { body: 'Reminder {{serviceName}} at {{appointmentTime}}' },
      PUSH: { subject: 'Reminder', body: '{{serviceName}}' },
    },
  },
];

const settings = {
  channels: { email: true, sms: true, push: true },
  reminders: { enabled: true, offsetsMinutes: [1440, 120] },
  eventChannels: {
    'appointment.created': ['EMAIL', 'SMS', 'PUSH'],
    'appointment.reminder': ['EMAIL', 'SMS', 'PUSH'],
  },
  catalog,
  channelsAvailable: ['EMAIL', 'SMS', 'PUSH'],
  variables: ['customerName', 'serviceName', 'appointmentTime'],
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'n-1',
  type: 'appointment.created',
  channel: 'EMAIL',
  status: 'SENT',
  recipientType: 'CUSTOMER',
  recipientAddress: 's***@example.com',
  subject: 'Your booking',
  preview: 'Hi Sara',
  appointmentId: 'a-1',
  scheduledFor: '2026-09-29T02:00:00.000Z',
  sentAt: '2026-09-29T02:00:05.000Z',
  failedAt: null,
  failureReason: null,
  retryCount: 0,
  maxRetries: 3,
  nextRetryAt: null,
  provider: 'mock-email',
  createdAt: '2026-09-29T02:00:00.000Z',
  ...overrides,
});

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
  });

type Handler = (url: URL, init?: RequestInit) => Response | undefined;

function api(handler: Handler) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handled = handler(url, init);
    if (handled) return Promise.resolve(handled);
    const path = url.pathname;
    if (path.endsWith('/notification-settings')) return Promise.resolve(json(envelope(settings)));
    if (path.endsWith('/notifications/stats')) {
      return Promise.resolve(
        json(
          envelope({
            byStatus: { SENT: 3, FAILED: 1, RETRYING: 1 },
            byChannel: {},
            pendingEvents: 0,
          }),
        ),
      );
    }
    return Promise.resolve(apiError(404, 'RESOURCE_NOT_FOUND', 'Not found'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const urlsOf = (mock: ReturnType<typeof api>) =>
  mock.mock.calls.map(([input]) => new URL(String(input), 'http://localhost'));

afterEach(() => vi.unstubAllGlobals());

// =============================================================================
describe('Notification history', () => {
  it('shows type, channel, recipient, status, sent time and error/retry state', async () => {
    api((url) =>
      url.pathname.endsWith('/notifications')
        ? json(
            envelope({
              items: [
                row(),
                row({
                  id: 'n-2',
                  channel: 'SMS',
                  status: 'RETRYING',
                  recipientAddress: '***2233',
                  sentAt: null,
                  failureReason: 'Gateway timeout',
                  retryCount: 1,
                  nextRetryAt: '2026-09-29T02:05:00.000Z',
                }),
                row({
                  id: 'n-3',
                  status: 'CANCELLED',
                  recipientAddress: 'x***@example.com',
                  sentAt: null,
                  failureReason: 'Invalid email address.',
                }),
              ],
              total: 3,
              limit: 25,
              offset: 0,
            }),
          )
        : undefined,
    );

    renderWithProviders(<NotificationsPage />, { session: session(['settings:read']) });

    const sent = (await screen.findByText('s***@example.com', { selector: 'td' })).closest('tr')!;
    expect(within(sent).getByText('Appointment booked')).toBeInTheDocument();
    expect(within(sent).getByText('Email')).toBeInTheDocument();
    expect(within(sent).getByText('Sent')).toBeInTheDocument();

    const retrying = screen.getByText('***2233').closest('tr')!;
    expect(within(retrying).getByText('Retrying')).toBeInTheDocument();
    expect(within(retrying).getByText('Gateway timeout')).toBeInTheDocument();
    expect(within(retrying).getByText(/retry 1 of 3/)).toBeInTheDocument();

    const cancelled = screen.getByText('x***@example.com').closest('tr')!;
    expect(within(cancelled).getByText('Invalid email address.')).toBeInTheDocument();
    expect(within(cancelled).getByText('Not sent')).toBeInTheDocument();
    // Read-only: no queue button.
    expect(screen.queryByRole('button', { name: 'Process queue now' })).toBeNull();
  });

  it('filters on the server and opens the full message', async () => {
    const fetchMock = api((url) => {
      if (url.pathname.endsWith('/notifications')) {
        return json(envelope({ items: [row()], total: 1, limit: 25, offset: 0 }));
      }
      if (url.pathname.endsWith('/notifications/n-1')) {
        return json(
          envelope({
            ...row(),
            body: 'Hi Sara,\n\nThank you for booking.',
            templateId: null,
            customTemplate: false,
            providerMessageId: 'x',
          }),
        );
      }
      return undefined;
    });
    const user = userEvent.setup();

    renderWithProviders(<NotificationsPage />, { session: session(['settings:read']) });
    await screen.findByText('s***@example.com');
    await user.selectOptions(screen.getByLabelText('Channel'), 'SMS');
    await user.selectOptions(screen.getByLabelText('Status'), 'FAILED');

    await waitFor(() =>
      expect(
        urlsOf(fetchMock).some(
          (u) =>
            u.pathname.endsWith('/notifications') &&
            u.searchParams.get('channel') === 'SMS' &&
            u.searchParams.get('status') === 'FAILED',
        ),
      ).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Appointment booked' }));
    expect(await screen.findByText(/Thank you for booking/)).toBeInTheDocument();
    expect(screen.getByText(/default wording/)).toBeInTheDocument();
  });

  it('refuses the page without settings access', () => {
    const fetchMock = api(() => undefined);
    renderWithProviders(<NotificationsPage />, { session: session(['customer:read']) });
    expect(
      screen.getByText('You do not have permission to see notifications.'),
    ).toBeInTheDocument();
    expect(urlsOf(fetchMock).some((u) => u.pathname.includes('/notifications'))).toBe(false);
  });
});

// =============================================================================
describe('Notification settings', () => {
  it('saves channels, reminder timing and default channels in one request', async () => {
    let sent: Record<string, unknown> | null = null;
    api((url, init) => {
      if (url.pathname.endsWith('/notification-settings') && init?.method === 'PATCH') {
        sent = bodyOf(init);
        return json(envelope(settings));
      }
      if (url.pathname.endsWith('/notifications'))
        return json(envelope({ items: [], total: 0, limit: 25, offset: 0 }));
      return undefined;
    });
    const user = userEvent.setup();

    renderWithProviders(<NotificationsPage />, {
      session: session(['settings:read', 'settings:write']),
    });
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));

    await user.click(await screen.findByRole('checkbox', { name: 'SMS' }));
    await user.click(screen.getByRole('checkbox', { name: '1 hour before' }));
    await user.click(screen.getByRole('checkbox', { name: '24 hours before' }));
    await user.click(screen.getByRole('checkbox', { name: 'Appointment booked by Push' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Notification settings saved.')).toBeInTheDocument();
    expect(sent).toEqual({
      channels: { email: true, sms: false, push: true },
      reminders: { enabled: true, offsetsMinutes: [120, 60] },
      eventChannels: {
        'appointment.created': ['EMAIL', 'SMS'],
        'appointment.reminder': ['EMAIL', 'SMS', 'PUSH'],
      },
    });
  });

  it('is read-only without settings:write', async () => {
    api((url) =>
      url.pathname.endsWith('/notifications')
        ? json(envelope({ items: [], total: 0, limit: 25, offset: 0 }))
        : undefined,
    );
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />, { session: session(['settings:read']) });
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(await screen.findByRole('checkbox', { name: 'SMS' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });
});

// =============================================================================
describe('Notification templates', () => {
  const existing = {
    id: 't-1',
    type: 'appointment.reminder',
    typeLabel: 'Appointment reminder',
    channel: 'SMS',
    subject: null,
    body: 'See you at {{appointmentTime}}',
    isActive: false,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
  };

  function templatesApi(onWrite?: Handler) {
    return api((url, init) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') return onWrite?.(url, init);
      if (url.pathname.endsWith('/notification-templates')) {
        return json(envelope({ items: [existing], catalog, variables: settings.variables }));
      }
      if (url.pathname.endsWith('/notifications'))
        return json(envelope({ items: [], total: 0, limit: 25, offset: 0 }));
      return undefined;
    });
  }

  it('marks which messages use the default and which the company’s own', async () => {
    templatesApi();
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />, {
      session: session(['settings:read', 'settings:write']),
    });
    await user.click(await screen.findByRole('tab', { name: 'Templates' }));

    expect(
      await screen.findByRole('button', { name: 'Appointment reminder SMS template' }),
    ).toHaveTextContent('Custom · off');
    expect(
      screen.getByRole('button', { name: 'Appointment booked Email template' }),
    ).toHaveTextContent('Default');
  });

  it('starts a new template from the default, previews it and creates it', async () => {
    let created: Record<string, unknown> | null = null;
    templatesApi((url, init) => {
      if (url.pathname.endsWith('/notification-templates/preview')) {
        return json(envelope({ subject: 'Your booking', body: 'Hi Sara!', length: 8, sample: {} }));
      }
      if (url.pathname.endsWith('/notification-templates')) {
        created = bodyOf(init);
        return json(envelope({ ...existing, id: 't-2', ...created }), 201);
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />, {
      session: session(['settings:read', 'settings:write']),
    });
    await user.click(await screen.findByRole('tab', { name: 'Templates' }));
    await user.click(
      await screen.findByRole('button', { name: 'Appointment booked Email template' }),
    );

    const body = screen.getByLabelText('Message');
    expect(body).toHaveValue('Hi {{customerName}}');
    expect(screen.getByLabelText('Subject')).toHaveValue('Your booking');
    await user.type(body, '!');

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('Hi Sara!')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Template saved.')).toBeInTheDocument();
    expect(created).toEqual({
      type: 'appointment.created',
      channel: 'EMAIL',
      subject: 'Your booking',
      body: 'Hi {{customerName}}!',
      isActive: true,
    });
  });

  it('edits an existing template and shows the server’s objection', async () => {
    const edits: Array<Record<string, unknown>> = [];
    templatesApi((url, init) => {
      if (!url.pathname.endsWith('/notification-templates/t-1')) return undefined;
      edits.push(bodyOf(init));
      return apiError(400, 'VALIDATION_FAILED', 'Request validation failed.', {
        issues: { body: 'Unknown variable {{time}}.' },
      });
    });
    const user = userEvent.setup();
    renderWithProviders(<NotificationsPage />, {
      session: session(['settings:read', 'settings:write']),
    });
    await user.click(await screen.findByRole('tab', { name: 'Templates' }));
    await user.click(
      await screen.findByRole('button', { name: 'Appointment reminder SMS template' }),
    );

    // SMS has no subject field, and shows its length.
    expect(screen.queryByLabelText('Subject')).toBeNull();
    expect(screen.getByText('30/480')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Active/ }));
    await user.click(screen.getByRole('button', { name: 'Save template' }));

    expect(await screen.findByText('Unknown variable {{time}}.')).toBeInTheDocument();
    expect(edits[0]).toEqual({
      subject: null,
      body: 'See you at {{appointmentTime}}',
      isActive: true,
    });
  });
});

// =============================================================================
describe('Customer notification preferences', () => {
  it('shows each channel and saves a change', async () => {
    let sent: Record<string, unknown> | null = null;
    api((url, init) => {
      if (!url.pathname.endsWith('/customers/c-1/notification-preferences')) return undefined;
      if (init?.method === 'PATCH') {
        sent = bodyOf(init);
        return json(
          envelope({
            customerId: 'c-1',
            enabled: { email: true, sms: false, push: true },
            reachable: { email: true, sms: true, push: false },
          }),
        );
      }
      return json(
        envelope({
          customerId: 'c-1',
          enabled: { email: true, sms: true, push: true },
          reachable: { email: true, sms: true, push: false },
        }),
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<CustomerNotificationPreferences customerId="c-1" />, {
      session: session(['customer:read', 'customer:write']),
    });

    const smsBox = await screen.findByRole('checkbox', { name: 'SMS' });
    expect(screen.getByText('No app device registered.')).toBeInTheDocument();
    await user.click(smsBox);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'SMS' })).not.toBeChecked());
    expect(sent).toEqual({ sms: false });
  });

  it('is read-only without customer:write, and absent without customer:read', async () => {
    api((url) =>
      url.pathname.endsWith('/notification-preferences')
        ? json(
            envelope({
              customerId: 'c-1',
              enabled: { email: true, sms: true, push: true },
              reachable: { email: false, sms: true, push: false },
            }),
          )
        : undefined,
    );
    const { unmount } = renderWithProviders(<CustomerNotificationPreferences customerId="c-1" />, {
      session: session(['customer:read']),
    });
    expect(await screen.findByRole('checkbox', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText('No valid email address on file.')).toBeInTheDocument();
    unmount();

    const { container } = renderWithProviders(
      <CustomerNotificationPreferences customerId="c-1" />,
      {
        session: session([]),
      },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
