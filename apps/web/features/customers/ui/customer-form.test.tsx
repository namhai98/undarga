import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders, sessionWith } from '@/test/render';
import { CustomerForm } from './customer-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/customers',
}));

const envelope = (data: unknown) => ({ data, meta: { requestId: 'r' } });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const session = sessionWith({
  activeCompanyId: 'co-1',
  permissions: new Set(['customer:read', 'customer:write', 'employee:read']),
  user: { id: 'u-1', email: 'a@example.com', displayName: 'A' },
});

/** Everything the form loads, plus a configurable response to the POST. */
function routeFetch(onCreate: () => Response) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/employees')) {
      return Promise.resolve(
        jsonResponse(envelope({ items: [], total: 0, limit: 100, offset: 0 })),
      );
    }
    if (init?.method === 'POST') return Promise.resolve(onCreate());

    return Promise.resolve(jsonResponse(envelope({ items: [], total: 0, limit: 25, offset: 0 })));
  });
}

const created = envelope({ id: 'cus-9', fullName: 'Sara', firstName: 'Sara' });

describe('CustomerForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let onDone: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onDone = vi.fn();
    fetchMock = routeFetch(() => jsonResponse(created, 201));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const setup = () =>
    renderWithProviders(<CustomerForm customerId={null} onDone={onDone} onCancel={vi.fn()} />, {
      session,
    });

  it('refuses a customer with neither phone nor email, without calling the API', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('First name'), 'Sara');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(
      await screen.findByText('Give at least a phone number or an email address.'),
    ).toBeInTheDocument();
    // The point of validating here: no wasted round trip.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(
      false,
    );
  });

  it('refuses a malformed email before submitting', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('First name'), 'Sara');
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
  });

  it('submits and splits comma-separated tags into an array', async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('First name'), 'Sara');
    await user.type(screen.getByLabelText('Phone'), '+976 9911 2233');
    await user.type(screen.getByLabelText('Tags'), 'vip, allergy');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    const body = JSON.parse(String((post?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({ firstName: 'Sara', phone: '+976 9911 2233' });
    expect(body.tags).toEqual(['vip', 'allergy']);
  });

  it('puts a duplicate rejection on the field it names and offers the existing record', async () => {
    /**
     * The whole reason the API returns `existingCustomerId`: telling somebody
     * "that number is taken" and then making them go and search for it is the
     * version of this that wastes a minute at a busy desk.
     */
    fetchMock = routeFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'CONFLICT',
            message: 'A customer with that phone number already exists here.',
            details: { field: 'phone', existingCustomerId: 'cus-existing' },
            requestId: 'r',
          },
        },
        409,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('First name'), 'Duplicate');
    await user.type(screen.getByLabelText('Phone'), '+97699112233');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(
      await screen.findByText('A customer with that phone number already exists here.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open that customer' })).toHaveAttribute(
      'href',
      '/customers/cus-existing',
    );
    // The form stays open with the typed values — nothing is lost.
    expect(onDone).not.toHaveBeenCalled();
  });

  it('shows a form-level message for a failure that names no field', async () => {
    fetchMock = routeFetch(() =>
      jsonResponse(
        { error: { code: 'INTERNAL', message: 'boom', requestId: 'r' } },
        500,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    setup();

    await user.type(screen.getByLabelText('First name'), 'Sara');
    await user.type(screen.getByLabelText('Phone'), '+97699112233');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
