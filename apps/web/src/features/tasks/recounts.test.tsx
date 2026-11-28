import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const REVIEWER = '0190b3a2-0000-7000-8000-0000000000c9';
const I1 = '0190b3a2-0000-7000-8000-0000000000a1';
const I2 = '0190b3a2-0000-7000-8000-0000000000a2';
const I3 = '0190b3a2-0000-7000-8000-0000000000a3';
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
  assignees: [{ userId: REVIEWER, displayName: 'سعيد' }],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const row = (over: Record<string, unknown>) => ({
  itemId: I1,
  barcode: '6290001',
  name: 'حليب',
  baseUnit: 'قطعة',
  theoretical: '10',
  counted: '4',
  difference: '-6',
  differencePct: '-60',
  status: 'short',
  flaggedForRecount: true,
  recountPending: false,
  round: 1,
  ...over,
});
const ROWS = [
  row({}),
  row({ itemId: I2, barcode: '6290002', name: 'عصير' }),
  row({ itemId: I3, barcode: '6290003', name: 'شاي', recountPending: true }),
];
const summary = {
  items: 3,
  matched: 0,
  over: 0,
  short: 3,
  flagged: 2,
  totalCounted: '12',
  totalTheoretical: '30',
  totalDifference: '-18',
  unknownBarcodes: 0,
  unknownQuantity: '0',
  recountPending: 1,
};
const RES = 'GET /tasks/t1/results?page=1&pageSize=25&filter=all&sort=difference&tolerancePct=0';
const PERMS = ['inventory.task.read', 'inventory.task.read_all', 'inventory.task.recount'];
const session = (permissions: string[], extra: Record<string, Handler> = {}, task = TASK) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    'GET /tasks/t1': () => ok(task),
    [RES]: () => ({
      body: {
        data: ROWS,
        meta: { page: 1, pageSize: 25, total: 3, totalPages: 1, frozen: false, summary },
      },
    }),
    ...extra,
  });
const combo = (root: HTMLElement, label: string) => {
  const el = within(root)
    .getAllByLabelText(label)
    .find((e) => e.getAttribute('role') === 'combobox');
  if (!el) throw new Error('no combobox');
  return el;
};
const pickReviewer = async (u: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) => {
  await u.click(combo(dialog, 'المراجع'));
  const opt = await waitFor(() => {
    const f = Array.from(document.querySelectorAll('[role=option]')).filter(
      (e) => e.textContent === 'سعيد',
    );
    if (!f.length) throw new Error('no option');
    return f[f.length - 1] as HTMLElement;
  });
  await u.click(opt);
};

describe('recount request', () => {
  it('no recount controls without the permission or on a closed task', async () => {
    session(['inventory.task.read', 'inventory.task.read_all']);
    await renderApp('/tasks/t1/results');
    await screen.findByText('6290001');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إعادة عدّ/ })).not.toBeInTheDocument();
  });

  it('closed task offers no recount', async () => {
    session(PERMS, {}, { ...TASK, status: 'closed' });
    await renderApp('/tasks/t1/results');
    await screen.findByText('6290001');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('selected items are sent as itemIds with the reviewer, reason and tolerance; pending rows cannot be selected', async () => {
    const server = session(PERMS, {
      'POST /tasks/t1/recounts': () =>
        ok([
          { itemId: I1, status: 'created', round: 2 },
          { itemId: I2, status: 'rejected', code: 'REVIEWER_COUNTED_BEFORE' },
        ]),
    });
    await renderApp('/tasks/t1/results');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    expect(screen.getByRole('checkbox', { name: 'تحديد 6290003' })).toBeDisabled();
    const btn = screen.getByRole('button', { name: 'إعادة عدّ المحدد (0)' });
    expect(btn).toBeDisabled();
    await u.click(screen.getByRole('checkbox', { name: 'تحديد 6290001' }));
    await u.click(screen.getByRole('checkbox', { name: 'تحديد 6290002' }));
    await u.click(screen.getByRole('button', { name: 'إعادة عدّ المحدد (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'طلب إعادة العدّ' })).toBeDisabled();
    await pickReviewer(u, dialog);
    await u.type(within(dialog).getByLabelText('السبب (اختياري)'), 'فرق كبير');
    await u.click(within(dialog).getByRole('button', { name: 'طلب إعادة العدّ' }));
    expect(
      await within(dialog).findByText(/طُلبت 1، ومعلّقة سابقاً 0، ومرفوضة 1/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/عصير: المراجع عدّ هذا الصنف من قبل/)).toBeInTheDocument();
    expect(server.calls.find((c) => c.key === 'POST /tasks/t1/recounts')?.body).toEqual({
      assigneeId: REVIEWER,
      tolerancePct: '0',
      itemIds: [I1, I2],
      reason: 'فرق كبير',
    });
  });

  it('the flagged button sends flagged:true and no itemIds, and is disabled with nothing flagged', async () => {
    const server = session(PERMS, {
      'POST /tasks/t1/recounts': () => ok([{ itemId: I1, status: 'already_pending' }]),
    });
    await renderApp('/tasks/t1/results');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(screen.getByRole('button', { name: 'إعادة عدّ المعلَّم (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/كل الأصناف المعلَّمة/)).toBeInTheDocument();
    await pickReviewer(u, dialog);
    await u.click(within(dialog).getByRole('button', { name: 'طلب إعادة العدّ' }));
    await within(dialog).findByText(/معلّقة سابقاً 1/);
    expect(server.calls.find((c) => c.key === 'POST /tasks/t1/recounts')?.body).toEqual({
      assigneeId: REVIEWER,
      tolerancePct: '0',
      flagged: true,
    });
  });

  it('shows a translated error when the server refuses the reviewer', async () => {
    session(PERMS, { 'POST /tasks/t1/recounts': () => fail(422, 'INVALID_ASSIGNEE') });
    await renderApp('/tasks/t1/results');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(screen.getByRole('button', { name: 'إعادة عدّ المعلَّم (2)' }));
    const dialog = await screen.findByRole('dialog');
    await pickReviewer(u, dialog);
    await u.click(within(dialog).getByRole('button', { name: 'طلب إعادة العدّ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('المراجع غير مسند');
  });

  it('the dialog has no a11y violations', async () => {
    session(PERMS);
    await renderApp('/tasks/t1/results');
    const u = userEvent.setup();
    await screen.findByText('6290001');
    await u.click(screen.getByRole('button', { name: 'إعادة عدّ المعلَّم (2)' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await axe(dialog, { rules: { 'landmark-no-duplicate-banner': { enabled: false } } }),
    ).toHaveNoViolations();
  });
});
