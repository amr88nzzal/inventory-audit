import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const W1 = '0190b3a2-0000-7000-8000-0000000000a1';
const U1 = '0190b3a2-0000-7000-8000-0000000000b1';
const U2 = '0190b3a2-0000-7000-8000-0000000000b2';
const U9 = '0190b3a2-0000-7000-8000-0000000000b9';
const WH = {
  id: W1,
  code: 'MAIN',
  name: 'الرئيسي',
  active: true,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
};
const WH_URL = 'GET /warehouses?page=1&pageSize=100&active=true&sort=name';
const T1 = {
  id: 't1',
  taskNo: 7,
  title: 'جرد نهاية العام',
  warehouseId: W1,
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
  balancesCount: 12,
  balancesUploadedAt: null,
  assignees: [{ userId: U9, displayName: 'سعيد' }],
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const T2 = { ...T1, id: 't2', taskNo: 8, title: 'جرد جارٍ', status: 'in_progress', assignees: [] };
const SUP = [
  'inventory.task.read',
  'inventory.task.read_all',
  'inventory.task.create',
  'inventory.task.update',
  'inventory.task.start',
  'inventory.task.cancel',
];
const BASE = 'GET /tasks?page=1&pageSize=25&sort=taskNo&dir=desc';
const listBody = (rows: unknown[], total = rows.length, totalPages = 1) => ({
  body: { data: rows, meta: { page: 1, pageSize: 25, total, totalPages } },
});
const session = (permissions: string[], extra: Record<string, Handler> = {}) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    [WH_URL]: () => listBody([WH]),
    ...extra,
  });
const listKeys = (calls: { key: string }[]) =>
  calls.filter((c) => c.key.startsWith('GET /tasks?')).map((c) => c.key);

// قوائم Mantine في jsdom: نصل إلى مربع التحرير بدوره، ونختار الخيار من DOM مباشرة (القائمة المنسدلة تبقى فيه).
// Mantine dropdowns in jsdom: reach the input by its role, and pick the option straight from the DOM (the dropdown stays in it).
const combo = (
  root: { getAllByLabelText: (t: RegExp | string) => HTMLElement[] },
  label: RegExp | string,
) => {
  const el = root.getAllByLabelText(label).find((e) => e.getAttribute('role') === 'combobox');
  if (!el) throw new Error(`no combobox ${String(label)}`);
  return el;
};
const pick = async (u: ReturnType<typeof userEvent.setup>, text: string) => {
  const opt = await waitFor(() => {
    const found = Array.from(document.querySelectorAll('[role=option]')).filter(
      (e) => e.textContent === text,
    );
    if (found.length === 0) throw new Error(`no option ${text}`);
    return found[found.length - 1] as HTMLElement;
  });
  await u.click(opt);
};

describe('tasks list', () => {
  it('hides the menu item without the read permission', async () => {
    session([]);
    await renderApp('/');
    await screen.findByText('مرحباً، مدير تجريبي');
    expect(screen.queryByRole('link', { name: 'مهام الجرد' })).not.toBeInTheDocument();
  });

  it('lists tasks with status badges and no a11y violations', async () => {
    session(SUP, { [BASE]: () => listBody([T1, T2]) });
    const { container } = await renderApp('/tasks');
    expect(await screen.findByRole('link', { name: '#7' })).toHaveAttribute('href', '/tasks/t1');
    expect(within(screen.getByRole('row', { name: /#7/ })).getByText('مسودة')).toBeInTheDocument();
    expect(
      within(screen.getByRole('row', { name: /#8/ })).getByText('قيد التنفيذ'),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reads status, warehouse, a numeric q and the page from the URL', async () => {
    const wid = '0190b3a2-1111-7222-8333-444455556666';
    const server = session(SUP, {
      [`GET /tasks?page=2&pageSize=25&sort=startsAt&dir=asc&q=12&status=in_progress&warehouseId=${wid}`]:
        () => listBody([T2], 40, 2),
    });
    await renderApp(
      `/tasks?page=2&sort=startsAt&dir=asc&q=12&status=in_progress&warehouseId=${wid}`,
    );
    await screen.findByRole('link', { name: '#8' });
    expect(listKeys(server.calls)).toHaveLength(1);
  });

  it('ignores an invalid status or warehouse id in the URL instead of sending it', async () => {
    const server = session(SUP, { [BASE]: () => listBody([T1]) });
    await renderApp('/tasks?status=hacked&warehouseId=not-a-uuid&page=-4');
    await screen.findByRole('link', { name: '#7' });
    expect(listKeys(server.calls)).toEqual([BASE]);
  });

  it('sorts by clicking a header and filters by status on the server', async () => {
    const server = session(SUP, {
      [BASE]: () => listBody([T1, T2]),
      'GET /tasks?page=1&pageSize=25&sort=taskNo&dir=asc': () => listBody([T1, T2]),
      'GET /tasks?page=1&pageSize=25&sort=taskNo&dir=desc&status=draft': () => listBody([T1]),
    });
    await renderApp('/tasks');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: '#7' });
    await u.click(screen.getByRole('button', { name: /الرقم/ }));
    await waitFor(() =>
      expect(listKeys(server.calls)).toContain('GET /tasks?page=1&pageSize=25&sort=taskNo&dir=asc'),
    );
    await u.click(combo(screen, 'الحالة'));
    await pick(u, 'مسودة');
    await waitFor(() => expect(listKeys(server.calls).at(-1)).toContain('status=draft'));
  });

  it('hides the create button without the create permission', async () => {
    session(['inventory.task.read'], { [BASE]: () => listBody([T1]) });
    await renderApp('/tasks');
    await screen.findByRole('link', { name: '#7' });
    expect(screen.queryByRole('button', { name: 'إنشاء مهمة' })).not.toBeInTheDocument();
  });

  it('create: validates first, loads people for the chosen warehouse only, sends a clean payload', async () => {
    const server = session(SUP, {
      [BASE]: () => listBody([]),
      [`GET /tasks/assignable-users?warehouseId=${W1}`]: () =>
        ok([
          { id: U1, displayName: 'ليلى' },
          { id: U2, displayName: 'سالم' },
        ]),
      'POST /tasks': () => ok(T1),
    });
    await renderApp('/tasks');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إنشاء مهمة' }));
    const dialog = await screen.findByRole('dialog');
    expect(combo(within(dialog), /المسندون/)).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText('العنوان مطلوب (حتى 160 حرفاً)')).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /tasks')).toBe(false);

    await u.type(within(dialog).getByLabelText(/العنوان/), 'جرد الربع');
    await u.click(combo(within(dialog), /المستودع/));
    await pick(u, 'MAIN — الرئيسي');
    await waitFor(() =>
      expect(
        server.calls.some((c) => c.key === `GET /tasks/assignable-users?warehouseId=${W1}`),
      ).toBe(true),
    );
    await u.click(combo(within(dialog), /المسندون/));
    await pick(u, 'ليلى');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.key === 'POST /tasks')?.body).toEqual({
      title: 'جرد الربع',
      warehouseId: W1,
      assigneeIds: [U1],
      blindCount: false,
      aggregateLocations: true,
    });
  });

  it('create: a server refusal of an assignee is explained in words', async () => {
    session(SUP, {
      [BASE]: () => listBody([]),
      [`GET /tasks/assignable-users?warehouseId=${W1}`]: () =>
        ok([{ id: U1, displayName: 'ليلى' }]),
      'POST /tasks': () => fail(422, 'ASSIGNEE_OUT_OF_SCOPE'),
    });
    await renderApp('/tasks');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إنشاء مهمة' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/العنوان/), 'x');
    await u.click(combo(within(dialog), /المستودع/));
    await pick(u, 'MAIN — الرئيسي');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'بعض المسندين لا يصلون إلى هذا المستودع',
    );
  });

  it('a user who may not list people sees why the assignee field is off', async () => {
    session(['inventory.task.read', 'inventory.task.create'], {
      [BASE]: () => listBody([]),
      [`GET /tasks/assignable-users?warehouseId=${W1}`]: () => fail(403, 'FORBIDDEN'),
    });
    await renderApp('/tasks');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إنشاء مهمة' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(combo(within(dialog), /المستودع/));
    await pick(u, 'MAIN — الرئيسي');
    expect(
      await within(dialog).findByText('لا تملك صلاحية عرض قائمة الموظفين للإسناد.'),
    ).toBeInTheDocument();
  });
});

describe('task detail', () => {
  const detail = (task: Record<string, unknown>, over: Record<string, Handler> = {}, perms = SUP) =>
    session(perms, { [`GET /tasks/${task['id']}`]: () => ok(task), ...over });

  it('a draft shows its terms and every action the user may take, with no a11y violations', async () => {
    detail(T1);
    const { container } = await renderApp('/tasks/t1');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '#7 — جرد نهاية العام',
    );
    expect(screen.getByText('سعيد')).toBeInTheDocument();
    expect(screen.getByText('12 صنف')).toBeInTheDocument();
    for (const n of ['تعديل', 'بدء المهمة', 'إلغاء المهمة'])
      expect(screen.getByRole('button', { name: n })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('start is disabled with a reason while nobody is assigned', async () => {
    detail({ ...T1, assignees: [] });
    await renderApp('/tasks/t1');
    expect(await screen.findByRole('button', { name: 'بدء المهمة' })).toBeDisabled();
    expect(screen.getByText('أسند موظفاً واحداً على الأقل ليمكن البدء.')).toBeInTheDocument();
  });

  it('a running task is frozen: no edit or start, cancel remains', async () => {
    detail(T2);
    await renderApp('/tasks/t2');
    await screen.findByText('المهمة بدأت: شروطها مجمّدة ولا تُعدَّل.');
    expect(screen.queryByRole('button', { name: 'تعديل' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'بدء المهمة' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إلغاء المهمة' })).toBeInTheDocument();
  });

  it('a closed or cancelled task offers no actions at all', async () => {
    detail({ ...T1, id: 't3', status: 'closed', closingNote: 'تم' });
    await renderApp('/tasks/t3');
    await screen.findByText('ملاحظة الإغلاق');
    for (const n of ['تعديل', 'بدء المهمة', 'إلغاء المهمة'])
      expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
  });

  it('a user with only read sees no action buttons', async () => {
    detail(T1, {}, ['inventory.task.read']);
    await renderApp('/tasks/t1');
    await screen.findByText('سعيد');
    for (const n of ['تعديل', 'بدء المهمة', 'إلغاء المهمة'])
      expect(screen.queryByRole('button', { name: n })).not.toBeInTheDocument();
  });

  it('shows one not-found message for a missing task', async () => {
    session(SUP, { 'GET /tasks/zz': () => fail(404, 'NOT_FOUND') });
    await renderApp('/tasks/zz');
    expect(await screen.findByText('المهمة غير موجودة')).toBeInTheDocument();
  });

  it('start needs confirmation with the impact, sends the version, and refreshes the task', async () => {
    let started = false;
    const server = detail(T1, {
      'GET /tasks/t1': () => ok(started ? { ...T1, status: 'in_progress', version: 4 } : T1),
      'POST /tasks/t1/start': () => {
        started = true;
        return ok({ ...T1, status: 'in_progress', version: 4 });
      },
    });
    await renderApp('/tasks/t1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'بدء المهمة' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('1 موظف');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.some((c) => c.key === 'POST /tasks/t1/start')).toBe(false);

    await u.click(screen.getByRole('button', { name: 'بدء المهمة' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'بدء المهمة' }),
    );
    expect(await screen.findByText('المهمة بدأت: شروطها مجمّدة ولا تُعدَّل.')).toBeInTheDocument();
    expect(server.calls.find((c) => c.key === 'POST /tasks/t1/start')?.body).toEqual({
      version: 3,
    });
  });

  it('a version conflict on start is explained and the task is reloaded', async () => {
    const server = detail(T1, { 'POST /tasks/t1/start': () => fail(409, 'VERSION_CONFLICT') });
    await renderApp('/tasks/t1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'بدء المهمة' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'بدء المهمة' }),
    );
    expect(await screen.findByText(/عدّل شخص آخر هذه المهمة/)).toBeInTheDocument();
    await waitFor(() =>
      expect(server.calls.filter((c) => c.key === 'GET /tasks/t1').length).toBeGreaterThan(1),
    );
  });

  it('cancel needs confirmation and sends the version', async () => {
    const server = detail(T2, {
      'POST /tasks/t2/cancel': () => ok({ ...T2, status: 'cancelled' }),
    });
    await renderApp('/tasks/t2');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إلغاء المهمة' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('تتوقف عمليات المسح');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء المهمة' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.key === 'POST /tasks/t2/cancel')).toBe(true),
    );
    expect(server.calls.find((c) => c.key === 'POST /tasks/t2/cancel')?.body).toEqual({
      version: 3,
    });
  });

  it('edit sends the version and null for cleared optional fields, keeping the warehouse fixed', async () => {
    const server = detail(
      { ...T1, tolerancePct: '2', notes: 'ملاحظة' },
      {
        [`GET /tasks/assignable-users?warehouseId=${W1}`]: () =>
          ok([{ id: U9, displayName: 'سعيد' }]),
        'PATCH /tasks/t1': () => ok(T1),
      },
    );
    await renderApp('/tasks/t1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/المستودع/)).not.toBeInTheDocument();
    await u.clear(within(dialog).getByLabelText('نسبة التفاوت %'));
    await u.clear(within(dialog).getByLabelText('ملاحظات'));
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.key === 'PATCH /tasks/t1')?.body).toEqual({
      version: 3,
      title: 'جرد نهاية العام',
      assigneeIds: [U9],
      blindCount: false,
      aggregateLocations: true,
      startsAt: null,
      tolerancePct: null,
      notes: null,
    });
  });
});
