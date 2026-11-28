import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const TASK = {
  id: 't1',
  taskNo: 7,
  title: 'جرد',
  warehouseId: 'w',
  warehouseName: 'الرئيسي',
  status: 'draft',
  startsAt: null,
  blindCount: false,
  aggregateLocations: true,
  tolerancePct: null,
  notes: null,
  closingNote: null,
  startedAt: null,
  closedAt: null,
  cancelledAt: null,
  balancesCount: 2,
  balancesUploadedAt: null,
  assignees: [],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const ROWS = [
  { itemId: 'i1', barcode: '6290001', name: 'حليب', baseUnit: 'علبة', quantity: '12.000' },
  { itemId: 'i2', barcode: '6290002', name: 'عصير', baseUnit: 'علبة', quantity: '5.500' },
];
const LIST = 'GET /tasks/t1/balances?page=1&pageSize=25';
const page = (rows: unknown[], totalPages = 1) => ({
  body: { data: rows, meta: { page: 1, pageSize: 25, total: rows.length, totalPages } },
});
const CSV = 'barcode,quantity\n6290001,12\n';
const REPORT = {
  mode: 'preview',
  totalRows: 3,
  validRows: 2,
  skipped: 0,
  errorsTotal: 1,
  errors: [{ line: 4, field: 'barcode', code: 'ITEM_NOT_FOUND', message: 'No item' }],
  errorsTruncated: false,
  ignoredColumns: [],
};

const session = (permissions: string[], task = TASK, extra: Record<string, Handler> = {}) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    [`GET /tasks/${task.id}`]: () => ok(task),
    [LIST]: () => page(ROWS),
    ...extra,
  });
const UP = ['inventory.task.read', 'inventory.task.balances'];
const upload = async (u: ReturnType<typeof userEvent.setup>) => {
  await screen.findByText('ملف CSV');
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await u.upload(input, new File([CSV], 'b.csv', { type: 'text/csv' }));
};
const posts = (calls: { key: string }[]) =>
  calls.filter((c) => c.key.startsWith('POST /tasks/t1/balances'));

describe('task balance snapshot', () => {
  it('the task page links to the snapshot', async () => {
    session(['inventory.task.read']);
    await renderApp('/tasks/t1');
    const link = await screen.findByRole('link', { name: 'لقطة الرصيد' });
    expect(link.getAttribute('href')).toMatch(/^\/tasks\/t1\/balances(\?|$)/);
  });

  it('lists the snapshot with no a11y violations', async () => {
    session(UP);
    const { container } = await renderApp('/tasks/t1/balances');
    expect(await screen.findByText('6290001')).toBeInTheDocument();
    expect(screen.getByText('5.500')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('searches and pages on the server, starting from the URL', async () => {
    const server = session(UP, TASK, {
      'GET /tasks/t1/balances?page=2&pageSize=25&q=629': () => page([ROWS[1]], 2),
    });
    await renderApp('/tasks/t1/balances?page=2&q=629');
    await screen.findByText('6290002');
    expect(
      server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/balances')).map((c) => c.key),
    ).toEqual(['GET /tasks/t1/balances?page=2&pageSize=25&q=629']);
  });

  it('a blind-count task hides the snapshot from an assignee with a clear message', async () => {
    session(
      ['inventory.task.read'],
      { ...TASK, blindCount: true },
      { [LIST]: () => fail(403, 'BLIND_COUNT') },
    );
    await renderApp('/tasks/t1/balances');
    expect(await screen.findByText(/عدّ أعمى/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('بحث')).not.toBeInTheDocument();
  });

  it('upload is offered only to a draft task and only with the balances permission', async () => {
    session(['inventory.task.read']);
    await renderApp('/tasks/t1/balances');
    await screen.findByText('6290001');
    expect(screen.queryByRole('button', { name: 'معاينة' })).not.toBeInTheDocument();
  });

  it('a started task shows the snapshot frozen with no upload', async () => {
    session(UP, { ...TASK, status: 'in_progress' });
    await renderApp('/tasks/t1/balances');
    expect(await screen.findByText('المهمة بدأت: اللقطة مجمّدة ولا تُستبدل.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'معاينة' })).not.toBeInTheDocument();
  });

  it('previews raw CSV with the translated unknown-barcode error, then applies behind a confirmation and refreshes the list', async () => {
    let applied = false;
    const server = session(UP, TASK, {
      'POST /tasks/t1/balances?mode=preview&skipInvalid=false': () => ok(REPORT),
      'POST /tasks/t1/balances?mode=preview&skipInvalid=true': () =>
        ok({ ...REPORT, skipped: 1, validRows: 2 }),
      'POST /tasks/t1/balances?mode=apply&skipInvalid=true': () => {
        applied = true;
        return ok({ ...REPORT, mode: 'apply', skipped: 1 });
      },
      [LIST]: () => page(applied ? [ROWS[0]] : ROWS),
    });
    await renderApp('/tasks/t1/balances');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    expect(await screen.findByText(/لا صنف بهذا الباركود/)).toBeInTheDocument();
    expect(posts(server.calls)[0]).toMatchObject({ body: CSV });
    expect(screen.getByRole('button', { name: 'تطبيق الاستيراد' })).toBeDisabled();

    await u.click(screen.getByLabelText(/تجاوز الصفوف الخاطئة/));
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    await screen.findByText(/لا صنف بهذا الباركود/);
    await u.click(screen.getByRole('button', { name: 'تطبيق الاستيراد' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('2 صنف');
    expect(dialog).toHaveTextContent('محل السابقة كاملة');
    await u.click(within(dialog).getByRole('button', { name: 'تطبيق الاستيراد' }));
    await screen.findByText('تم الاستيراد');
    await waitFor(() => expect(screen.queryByText('6290002')).not.toBeInTheDocument());
    expect(posts(server.calls).filter((c) => c.key.includes('mode=apply'))).toHaveLength(1);
  });

  it('a task that started meanwhile is explained in words', async () => {
    session(UP, TASK, {
      'POST /tasks/t1/balances?mode=preview&skipInvalid=false': () =>
        fail(409, 'TASK_NOT_EDITABLE'),
    });
    await renderApp('/tasks/t1/balances');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('لا تُعدَّل إلا المسودة');
  });

  it('a file with no valid row cannot be applied', async () => {
    session(UP, TASK, {
      'POST /tasks/t1/balances?mode=preview&skipInvalid=false': () =>
        ok({ ...REPORT, validRows: 0, errorsTotal: 0, errors: [] }),
    });
    await renderApp('/tasks/t1/balances');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    await screen.findByText('نتيجة المعاينة');
    expect(screen.getByRole('button', { name: 'تطبيق الاستيراد' })).toBeDisabled();
  });
});
