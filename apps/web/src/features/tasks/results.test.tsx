import { screen, waitFor } from '@testing-library/react';
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
  balancesCount: 3,
  balancesUploadedAt: null,
  assignees: [],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const row = (over: Record<string, unknown>) => ({
  itemId: 'i1',
  barcode: '6290001',
  name: 'حليب',
  baseUnit: 'قطعة',
  theoretical: '10',
  counted: '10',
  difference: '0',
  differencePct: '0',
  status: 'match',
  flaggedForRecount: false,
  recountPending: false,
  round: 1,
  ...over,
});
const ROWS = [
  row({}),
  row({
    itemId: 'i2',
    barcode: '6290002',
    name: 'عصير',
    counted: '4',
    difference: '-6',
    differencePct: '-60',
    status: 'short',
    flaggedForRecount: true,
  }),
  row({
    itemId: 'i3',
    barcode: '6290003',
    name: 'شاي',
    theoretical: '0',
    counted: '2',
    difference: '2',
    differencePct: null,
    status: 'over',
    recountPending: true,
  }),
];
const summary = (over: Record<string, unknown> = {}) => ({
  items: 3,
  matched: 1,
  over: 1,
  short: 1,
  flagged: 1,
  totalCounted: '16',
  totalTheoretical: '20',
  totalDifference: '-4',
  unknownBarcodes: 1,
  unknownQuantity: '5',
  recountPending: 1,
  ...over,
});
const meta = (over: Record<string, unknown> = {}, sum = summary()) => ({
  page: 1,
  pageSize: 25,
  total: 3,
  totalPages: 1,
  frozen: false,
  summary: sum,
  ...over,
});
const BASE = 'page=1&pageSize=25&filter=all&sort=difference&tolerancePct=0';
const RES = `GET /tasks/t1/results?${BASE}`;
const UNK = 'GET /tasks/t1/results/unknown?page=1&pageSize=25';
const SUP = ['inventory.task.read', 'inventory.task.read_all'];
const session = (permissions: string[], extra: Record<string, Handler> = {}, task = TASK) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    'GET /tasks/t1': () => ok(task),
    [RES]: () => ({ body: { data: ROWS, meta: meta() } }),
    [UNK]: () => ok([{ barcode: '999', quantity: '5', records: 2 }]),
    ...extra,
  });
const resultCalls = (server: ReturnType<typeof session>) =>
  server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/results?')).map((c) => c.key);

describe('task results', () => {
  it('the task page links to results only for read_all and a started task', async () => {
    session(SUP);
    await renderApp('/tasks/t1');
    const link = await screen.findByRole('link', { name: 'النتائج والفروقات' });
    expect(link.getAttribute('href')).toMatch(/^\/tasks\/t1\/results(\?|$)/);
  });

  it('hides the results link without read_all', async () => {
    session(['inventory.task.read']);
    await renderApp('/tasks/t1');
    await screen.findByRole('link', { name: 'سجل المسح' });
    expect(screen.queryByRole('link', { name: 'النتائج والفروقات' })).not.toBeInTheDocument();
  });

  it('hides the results link for a draft task', async () => {
    session(SUP, {}, { ...TASK, status: 'draft' });
    await renderApp('/tasks/t1');
    await screen.findByRole('link', { name: 'سجل المسح' });
    expect(screen.queryByRole('link', { name: 'النتائج والفروقات' })).not.toBeInTheDocument();
  });

  it('shows rows, summary, statuses and unknown barcodes, with no a11y violations', async () => {
    session(SUP);
    const { container } = await renderApp('/tasks/t1/results');
    expect(await screen.findByText('6290002')).toBeInTheDocument();
    expect(screen.getByText('يحتاج إعادة عدّ')).toBeInTheDocument();
    expect(screen.getByText('إعادة العدّ معلّقة')).toBeInTheDocument();
    expect(screen.getByText('-60%')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(await screen.findByText('999')).toBeInTheDocument();
    expect(screen.getByText(/نتائج حيّة/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('a frozen result shows the frozen notice and no tolerance input', async () => {
    session(SUP, { [RES]: () => ({ body: { data: ROWS, meta: meta({ frozen: true }) } }) });
    await renderApp('/tasks/t1/results');
    expect(await screen.findByText(/النتائج مجمّدة/)).toBeInTheDocument();
    expect(screen.queryByLabelText('تفاوت افتراضي %')).not.toBeInTheDocument();
  });

  it('no unknown section and no unknown request when there are none', async () => {
    const server = session(SUP, {
      [RES]: () => ({
        body: { data: ROWS, meta: meta({}, summary({ unknownBarcodes: 0, unknownQuantity: '0' })) },
      }),
    });
    await renderApp('/tasks/t1/results');
    await screen.findByText('6290002');
    expect(screen.queryByText('باركودات غير معرّفة')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        server.calls.filter((c) => c.key.startsWith('GET /tasks/t1/results/unknown')),
      ).toHaveLength(1),
    );
  });

  it('sends filter, sort, q and tolerance from the URL; invalid values fall back to defaults', async () => {
    const key =
      'GET /tasks/t1/results?page=2&pageSize=25&filter=short&sort=name&tolerancePct=2.5&q=%D8%AD';
    const server = session(SUP, {
      [key]: () => ({ body: { data: ROWS, meta: meta({ page: 2, totalPages: 3 }) } }),
    });
    await renderApp('/tasks/t1/results?page=2&filter=short&sort=name&tolerancePct=2.5&q=%D8%AD');
    await screen.findByText('6290002');
    expect(resultCalls(server)).toEqual([key]);
  });

  it('drops invalid URL params instead of sending them', async () => {
    const server = session(SUP);
    await renderApp('/tasks/t1/results?page=0&filter=hacked&sort=x&tolerancePct=abc');
    await screen.findByText('6290002');
    expect(resultCalls(server)).toEqual([RES]);
  });

  it('typing a tolerance refetches with it; an invalid one shows an error and is not sent', async () => {
    const key = `GET /tasks/t1/results?page=1&pageSize=25&filter=all&sort=difference&tolerancePct=5`;
    const server = session(SUP, { [key]: () => ({ body: { data: ROWS, meta: meta() } }) });
    await renderApp('/tasks/t1/results');
    await screen.findByText('6290002');
    const u = userEvent.setup();
    const input = screen.getByLabelText('تفاوت افتراضي %');
    await u.clear(input);
    await u.type(input, 'x');
    expect(await screen.findByText('قيمة غير صالحة')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 600));
    expect(resultCalls(server).some((k) => k.includes('tolerancePct=x'))).toBe(false);
    await u.clear(input);
    await u.type(input, '5');
    await waitFor(() => expect(resultCalls(server)).toContain(key));
    expect(resultCalls(server).some((k) => k.includes('tolerancePct=x'))).toBe(false);
  });

  it('shows an error when the server refuses (403)', async () => {
    session(['inventory.task.read'], { [RES]: () => fail(403, 'FORBIDDEN') });
    await renderApp('/tasks/t1/results');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('empty page shows the empty note', async () => {
    session(SUP, { [RES]: () => ({ body: { data: [], meta: meta({ total: 0 }) } }) });
    await renderApp('/tasks/t1/results');
    expect(await screen.findByText('لا أصناف مطابقة')).toBeInTheDocument();
  });
});
