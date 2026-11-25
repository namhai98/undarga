import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { MembersPage } from './members-page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/members',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const session = (permissions: string[]) =>
  sessionWith({
    activeCompanyId: 'co-1',
    permissions: new Set(permissions),
    user: { id: 'u-1', email: 'me@example.com', displayName: 'Me' },
  });

const role = (key: string, name: string) => ({
  key,
  name,
  description: null,
  isSystem: true,
  permissions: [],
});
const roles = [
  role('ADMIN', 'Admin'),
  role('RECEPTIONIST', 'Receptionist'),
  role('READ_ONLY', 'Read only'),
];

const member = (overrides: Record<string, unknown>) => ({
  id: 'm-1',
  userAccountId: 'u-x',
  email: 'x@example.com',
  name: 'X',
  status: 'ACTIVE',
  isOwner: false,
  isYou: false,
  roles: [{ key: 'RECEPTIONIST', name: 'Receptionist' }],
  joinedAt: null,
  ...overrides,
});

const members = [
  member({ id: 'm-owner', name: 'Olga', isOwner: true, roles: [{ key: 'OWNER', name: 'Owner' }] }),
  member({ id: 'm-me', name: 'Me', isYou: true, roles: [{ key: 'ADMIN', name: 'Admin' }] }),
  member({ id: 'm-sara', name: 'Sara' }),
];

function routes(
  extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = extra(url, init);
    if (custom) return Promise.resolve(custom);
    if (url.includes('/members/roles')) return Promise.resolve(json(envelope({ items: roles })));
    if (url.includes('/members/invitations')) {
      return Promise.resolve(json(envelope({ items: [], total: 0 })));
    }
    return Promise.resolve(json(envelope({ items: members })));
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('MembersPage', () => {
  it('offers no role or remove controls on yourself or the owner', async () => {
    vi.stubGlobal('fetch', routes());
    renderWithProviders(<MembersPage />, {
      session: session(['member:read', 'member:write', 'member:remove']),
    });

    expect(await screen.findByRole('button', { name: 'Change roles of Sara' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change roles of Me' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change roles of Olga' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Me' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Olga' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Sara' })).toBeInTheDocument();
  });

  it('changes a role and shows the server’s refusal when it says no', async () => {
    const fetchMock = routes((url, init) =>
      url.includes('/roles') && init?.method === 'PUT'
        ? json(
            {
              error: {
                code: 'PRIVILEGE_ESCALATION_BLOCKED',
                message: 'You cannot grant permissions you do not hold yourself.',
                requestId: 'r',
              },
            },
            403,
          )
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<MembersPage />, { session: session(['member:read', 'member:write']) });

    // Several roles at once: Sara keeps Receptionist and gains Admin.
    await user.click(await screen.findByRole('button', { name: 'Change roles of Sara' }));
    expect(screen.getByLabelText('Receptionist for Sara')).toBeChecked();
    await user.click(screen.getByLabelText('Admin for Sara'));
    await user.click(screen.getByRole('button', { name: 'Save roles' }));

    expect(
      await screen.findByText('You cannot grant permissions you do not hold yourself.'),
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(
      ([, i]) => (i as RequestInit | undefined)?.method === 'PUT',
    );
    expect(String(call![0])).toMatch(/\/members\/m-sara\/roles$/);
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      roleKeys: ['RECEPTIONIST', 'ADMIN'],
    });
    // The company travels in the header: these routes are not company-scoped by path.
    expect(((call![1] as RequestInit).headers as Record<string, string>)['X-Company-Id']).toBe(
      'co-1',
    );
  });

  it('creates an invitation and shows its one-time link', async () => {
    const fetchMock = routes((url, init) =>
      url.includes('/members/invitations') && init?.method === 'POST'
        ? json(
            envelope({
              id: 'inv-1',
              email: 'new@example.com',
              status: 'PENDING',
              roles: [{ key: 'RECEPTIONIST', name: 'Receptionist' }],
              expiresAt: '2026-12-01T00:00:00.000Z',
              createdAt: '2026-11-24T00:00:00.000Z',
              token: 'secret-token',
              acceptUrl: 'https://app.example.com/invitations/accept?token=secret-token',
            }),
            201,
          )
        : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<MembersPage />, {
      session: session(['member:read', 'member:invite']),
    });

    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await waitFor(() => expect(screen.getByLabelText('Role')).toHaveValue('RECEPTIONIST'));
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    const status = await screen.findByRole('status');
    expect(within(status).getByLabelText('Invitation link')).toHaveValue(
      'https://app.example.com/invitations/accept?token=secret-token',
    );
  });

  it('tells someone without member:read that they cannot see members', () => {
    vi.stubGlobal('fetch', routes());
    renderWithProviders(<MembersPage />, { session: session([]) });
    expect(screen.getByText('You do not have permission to see members.')).toBeInTheDocument();
  });
});

describe('RolesCard', () => {
  it('creates a role from the permissions you hold; ones you lack are disabled', async () => {
    const fetchMock = routes((url, init) => {
      if (url.endsWith('/members/permissions')) {
        return json(envelope({ items: ['customer:read', 'customer:write', 'member:remove'] }));
      }
      if (url.endsWith('/members/roles') && init?.method === 'POST') {
        return json(envelope(role('C_FRONT_DESK', 'Front desk')), 201);
      }
      return undefined;
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderWithProviders(<MembersPage />, {
      session: session([
        'member:read',
        'role:read',
        'role:write',
        'customer:read',
        'customer:write',
      ]),
    });

    // Built-in roles are listed but not editable.
    expect(await screen.findByText('Receptionist')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Create a role' }));
    await user.type(screen.getByLabelText('Role name'), 'Front desk');
    expect(await screen.findByLabelText('member:remove')).toBeDisabled();
    await user.click(screen.getByLabelText('customer:read'));
    await user.click(screen.getByLabelText('customer:write'));
    await user.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith('/members/roles') && (i as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        name: 'Front desk',
        description: null,
        permissions: ['customer:read', 'customer:write'],
      });
    });
  });
});
