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
const summary = (over: Record<string, unknown> = {}) => ({
  items: 3,
  matched: 3,
  over: 0,
  short: 0,
  flagged: 0,
  totalCounted: '16',
  totalTheoretical: '16',
  totalDifference: '0',
  unknownBarcodes: 0,
  unknownQuantity: '0',
  recountPending: 0,
  ...over,
});
const RES = 'GET /tasks/t1/results?page=1&pageSize=25&filter=all&sort=difference&tolerancePct=0';
const results =
  (over: Record<string, unknown> = {}) =>
  () => ({
    body: {
      data: [],
      meta: {
        page: 1,
        pageSize: 25,
        total: 0,
        totalPages: 1,
        frozen: false,
        summary: summary(over),
      },
    },
  });
const PERMS = ['inventory.task.read', 'inventory.task.read_all', 'inventory.task.close'];
const session = (
  permissions: string[],
  sum: Record<string, unknown> = {},
  extra: Record<string, Handler> = {},
  task = TASK,
) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    'GET /tasks/t1': () => ok(task),
    [RES]: results(sum),
    ...extra,
  });
const openDialog = async () => {
  const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'إغلاق المهمة' }));
  return { u, dialog: await screen.findByRole('dialog') };
};
const submitBtn = (d: HTMLElement) => within(d).getByRole('button', { name: 'إغلاق المهمة' });

describe('close task', () => {
  it('the close button needs the close permission and a running task', async () => {
    session(['inventory.task.read', 'inventory.task.read_all']);
    await renderApp('/tasks/t1/results');
    await screen.findByText(/نتائج حيّة/);
    expect(screen.queryByRole('button', { name: 'إغلاق المهمة' })).not.toBeInTheDocument();
  });

  it('no close button on a closed task', async () => {
    session(PERMS, {}, {}, { ...TASK, status: 'closed' });
    await renderApp('/tasks/t1/results');
    await screen.findByText(/نتائج/);
    expect(screen.queryByRole('button', { name: 'إغلاق المهمة' })).not.toBeInTheDocument();
  });

  it('closes with a fresh Idempotency-Key header, the task version and the note; no a11y violations', async () => {
    let headers: Record<string, string> = {};
    const server = session(
      PERMS,
      {},
      {
        'POST /tasks/t1/close': (_b, init) => {
          headers = init.headers as Record<string, string>;
          return ok({ ...TASK, status: 'closed' });
        },
      },
    );
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    // ترويسة نافذة Mantine عنصر header فيُحسب banner مكرراً؛ نستثنيه هذه القاعدة فقط.
    // Mantine's modal header is a <header>, flagged as a duplicate banner; only that rule is excluded.
    expect(
      await axe(dialog, { rules: { 'landmark-no-duplicate-banner': { enabled: false } } }),
    ).toHaveNoViolations();
    await u.type(within(dialog).getByLabelText('ملاحظة الإغلاق (اختياري)'), '  تم  ');
    await u.click(submitBtn(dialog));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const call = server.calls.find((c) => c.key === 'POST /tasks/t1/close');
    expect(call?.body).toEqual({ version: 3, acknowledgeFlagged: false, note: 'تم' });
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('flagged items require the acknowledgement before the submit is enabled, and it is sent', async () => {
    const server = session(
      PERMS,
      { flagged: 2 },
      { 'POST /tasks/t1/close': () => ok({ ...TASK, status: 'closed' }) },
    );
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    expect(within(dialog).getByText(/2 صنف فرقه فوق التفاوت/)).toBeInTheDocument();
    expect(submitBtn(dialog)).toBeDisabled();
    await u.click(within(dialog).getByRole('checkbox'));
    expect(submitBtn(dialog)).toBeEnabled();
    await u.click(submitBtn(dialog));
    await waitFor(() =>
      expect(server.calls.find((c) => c.key === 'POST /tasks/t1/close')?.body).toEqual({
        version: 3,
        acknowledgeFlagged: true,
      }),
    );
  });

  it('a pending recount blocks closing even after acknowledging', async () => {
    const server = session(PERMS, { flagged: 1, recountPending: 2 });
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    expect(within(dialog).getByText(/2 إعادة عدّ معلّقة/)).toBeInTheDocument();
    await u.click(within(dialog).getByRole('checkbox'));
    expect(submitBtn(dialog)).toBeDisabled();
    expect(server.calls.some((c) => c.key === 'POST /tasks/t1/close')).toBe(false);
  });

  it('shows a translated error and uses a new key after a logical failure', async () => {
    const keys: string[] = [];
    session(
      PERMS,
      {},
      {
        'POST /tasks/t1/close': (_b, init) => {
          keys.push((init.headers as Record<string, string>)['Idempotency-Key'] as string);
          return fail(409, 'UNRESOLVED_VARIANCES');
        },
      },
    );
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    await u.click(submitBtn(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('بقيت فروقات معلَّمة');
    await u.click(submitBtn(dialog));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('keeps the same key when retrying after a network failure', async () => {
    const keys: string[] = [];
    let n = 0;
    session(
      PERMS,
      {},
      {
        'POST /tasks/t1/close': (_b, init) => {
          keys.push((init.headers as Record<string, string>)['Idempotency-Key'] as string);
          n += 1;
          if (n === 1) throw new TypeError('network');
          return ok({ ...TASK, status: 'closed' });
        },
      },
    );
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    await u.click(submitBtn(dialog));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    await u.click(submitBtn(dialog));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
  });

  it('a version conflict reloads the task and shows the conflict message', async () => {
    let reads = 0;
    session(
      PERMS,
      {},
      {
        'GET /tasks/t1': () => {
          reads += 1;
          return ok(TASK);
        },
        'POST /tasks/t1/close': () => fail(409, 'VERSION_CONFLICT'),
      },
    );
    await renderApp('/tasks/t1/results');
    const { u, dialog } = await openDialog();
    await u.click(submitBtn(dialog));
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});
