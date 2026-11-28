import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const ME = user().id;
const OTHER = '0190b3a2-0000-7000-8000-0000000000c9';
const TASK = {
  id: 't1',
  taskNo: 7,
  title: 'جرد',
  warehouseId: 'w',
  warehouseName: 'الرئيسي',
  status: 'in_progress',
  startsAt: null,
  blindCount: false,
  aggregateLocations: true,
  tolerancePct: null,
  notes: null,
  closingNote: null,
  startedAt: null,
  closedAt: null,
  cancelledAt: null,
  balancesCount: 0,
  balancesUploadedAt: null,
  assignees: [
    { userId: ME, displayName: 'أنا' },
    { userId: OTHER, displayName: 'سعيد' },
  ],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const scan = (over: Record<string, unknown>) => ({
  id: 's1',
  kind: 'count',
  userId: ME,
  userName: 'أنا',
  barcode: '6290001',
  itemId: 'i1',
  itemName: 'حليب',
  quantity: '3',
  unitName: null,
  baseQuantity: '3',
  locationCode: 'A-01',
  voidsId: null,
  voided: false,
  note: null,
  scannedAt: '2026-11-01T10:00:00Z',
  receivedAt: '2026-11-01T10:00:01Z',
  ...over,
});
const MINE = scan({});
const THEIRS = scan({
  id: 's2',
  userId: OTHER,
  userName: 'سعيد',
  barcode: '6290002',
  itemName: 'عصير',
});
const UNKNOWN = scan({ id: 's3', barcode: '999', itemId: null, itemName: null });
const VOIDED = scan({ id: 's4', voided: true, barcode: '6290004' });
const VOIDREC = scan({
  id: 's5',
  kind: 'void',
  voidsId: 's4',
  barcode: null,
  itemName: null,
  quantity: null,
});
const LIST = 'GET /tasks/t1/scans?page=1&pageSize=25';
const page = (rows: unknown[], totalPages = 1) => ({
  body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length, totalPages } },
});
const SUP = ['inventory.task.read', 'inventory.task.read_all', 'inventory.task.scan'];
const session = (permissions: string[], task = TASK, extra: Record<string, Handler> = {}) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    [`GET /tasks/${task.id}`]: () => ok(task),
    [LIST]: () => page([MINE, THEIRS, UNKNOWN, VOIDED, VOIDREC]),
    ...extra,
  });
const voidBtn = (barcode: string) => screen.queryByRole('button', { name: `إبطال ${barcode}` });

describe('task scan log', () => {
  it('the task page links to the scan log', async () => {
    session(SUP);
    await renderApp('/tasks/t1');
    const link = await screen.findByRole('link', { name: 'سجل المسح' });
    expect(link.getAttribute('href')).toMatch(/^\/tasks\/t1\/scans(\?|$)/);
  });

  it('lists counts, voids, voided counts and unknown items, with no a11y violations', async () => {
    session(SUP);
    const { container } = await renderApp('/tasks/t1/scans');
    expect(await screen.findByText('6290001')).toBeInTheDocument();
    expect(screen.getByText('صنف غير معرّف')).toBeInTheDocument();
    expect(screen.getByText('مُبطَل')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('only my own live counts on a running task can be voided', async () => {
    session(SUP);
    await renderApp('/tasks/t1/scans');
    await screen.findByText('6290001');
    expect(voidBtn('6290001')).toBeInTheDocument();
    expect(voidBtn('999')).toBeInTheDocument();
    expect(voidBtn('6290002')).not.toBeInTheDocument();
    expect(voidBtn('6290004')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^إبطال/ })).toHaveLength(2);
  });

  it('no void buttons without the scan permission or once the task is no longer running', async () => {
    session(['inventory.task.read', 'inventory.task.read_all']);
    await renderApp('/tasks/t1/scans');
    await screen.findByText('6290001');
    expect(voidBtn('6290001')).not.toBeInTheDocument();
  });

  it('a closed task offers no void', async () => {
    session(SUP, { ...TASK, status: 'closed' });
    await renderApp('/tasks/t1/scans');
    await screen.findByText('6290001');
    expect(voidBtn('6290001')).not.toBeInTheDocument();
  });

  it('a user without read_all sees the own-records note and no employee filter', async () => {
    session(['inventory.task.read', 'inventory.task.scan']);
    await renderApp('/tasks/t1/scans');
    expect(await screen.findByText('ترى سجلاتك أنت فقط.')).toBeInTheDocument();
    expect(screen.queryByLabelText('الموظف')).not.toBeInTheDocument();
  });

  it('filters by kind and by employee on the server; a user id is ignored without read_all', async () => {
    const server = session(SUP, TASK, {
      [`${LIST}&kind=void&userId=${OTHER}`]: () => page([VOIDREC]),
    });
    await renderApp(`/tasks/t1/scans?kind=void&userId=${OTHER}`);
    await screen.findByText('إبطال', { selector: '.mantine-Badge-label' });
    expect(
      server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/scans')).map((c) => c.key),
    ).toEqual([`${LIST}&kind=void&userId=${OTHER}`]);
  });

  it('an invalid employee id in the URL is dropped instead of being sent', async () => {
    const server = session(SUP);
    await renderApp('/tasks/t1/scans?userId=not-a-uuid&kind=hacked&page=0');
    await screen.findByText('6290001');
    expect(
      server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/scans')).map((c) => c.key),
    ).toEqual([LIST]);
  });

  it('does not send the employee filter for a user without read_all', async () => {
    const server = session(['inventory.task.read'], TASK, {
      'GET /tasks/t1/scans?page=1&pageSize=25': () => page([MINE]),
    });
    await renderApp(`/tasks/t1/scans?userId=${OTHER}`);
    await screen.findByText('6290001');
    expect(
      server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/scans')).map((c) => c.key),
    ).toEqual(['GET /tasks/t1/scans?page=1&pageSize=25']);
  });

  it('voiding needs confirmation, then posts a void event pointing at the count, and refreshes the log', async () => {
    let n = 0;
    const server = session(SUP, TASK, {
      [LIST]: () => page(n === 0 ? [MINE] : [{ ...MINE, voided: true }]),
      'POST /tasks/t1/scans': () => {
        n += 1;
        return ok([{ id: 'x', status: 'created' }]);
      },
    });
    await renderApp('/tasks/t1/scans');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(voidBtn('6290001') as HTMLElement);
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('6290001');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.some((c) => c.key === 'POST /tasks/t1/scans')).toBe(false);

    await u.click(voidBtn('6290001') as HTMLElement);
    dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'إبطال' }));
    await waitFor(() => expect(screen.getByText('مُبطَل')).toBeInTheDocument());
    const body = server.calls.find((c) => c.key === 'POST /tasks/t1/scans')?.body as {
      events: Record<string, unknown>[];
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'void', voidsId: 's1' });
    expect(body.events[0]?.['id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a rejected void (arriving as a success payload) is explained and the dialog stays', async () => {
    session(SUP, TASK, {
      [LIST]: () => page([MINE]),
      'POST /tasks/t1/scans': () =>
        ok([{ id: 'x', status: 'rejected', code: 'ALREADY_VOIDED', message: 'x' }]),
    });
    await renderApp('/tasks/t1/scans');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(voidBtn('6290001') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'إبطال' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('هذا العدّ مُبطَل سابقاً');
  });

  it('a task that stopped running is explained', async () => {
    session(SUP, TASK, {
      [LIST]: () => page([MINE]),
      'POST /tasks/t1/scans': () => fail(409, 'TASK_NOT_RUNNING'),
    });
    await renderApp('/tasks/t1/scans');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(voidBtn('6290001') as HTMLElement);
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'إبطال' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('المهمة ليست جارية');
  });

  it('shows one not-found message for a missing task', async () => {
    session(SUP, TASK, { 'GET /tasks/zz': () => fail(404, 'NOT_FOUND') });
    await renderApp('/tasks/zz/scans');
    expect(await screen.findByText('المهمة غير موجودة')).toBeInTheDocument();
  });
});
