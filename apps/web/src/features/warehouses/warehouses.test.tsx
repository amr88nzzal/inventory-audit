import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const W1 = {
  id: 'w1',
  code: 'MAIN',
  name: 'المستودع الرئيسي',
  active: true,
  version: 3,
  createdAt: '2026-01-01T00:00:00Z',
};
const W2 = {
  id: 'w2',
  code: 'COLD',
  name: 'مستودع التبريد',
  active: false,
  version: 1,
  createdAt: '2026-01-02T00:00:00Z',
};
const L1 = { id: 'l1', warehouseId: 'w1', code: 'A-01', name: 'رف أ1', active: true, version: 2 };
const FULL = [
  'inventory.warehouse.read',
  'inventory.warehouse.create',
  'inventory.warehouse.update',
  'inventory.warehouse.delete',
];

const listBody = (rows: unknown[], total = rows.length, totalPages = 1) => ({
  body: { data: rows, meta: { page: 1, pageSize: 25, total, totalPages } },
});
const session = (permissions: string[], extra: Record<string, Handler> = {}) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    ...extra,
  });
const listKey = (calls: { key: string }[]) =>
  calls.filter((c) => c.key.startsWith('GET /warehouses?')).map((c) => c.key);

describe('warehouses list', () => {
  it('shows the menu item only with the read permission', async () => {
    session([], { 'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([]) });
    await renderApp('/');
    await screen.findByText('مرحباً، مدير تجريبي');
    expect(screen.queryByRole('link', { name: 'المستودعات' })).not.toBeInTheDocument();
  });

  it('lists rows from the server with no a11y violations, and links to the detail page', async () => {
    session(FULL, {
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([W1, W2]),
    });
    const { container } = await renderApp('/warehouses');
    expect(await screen.findByRole('link', { name: 'MAIN' })).toHaveAttribute(
      'href',
      '/warehouses/w1',
    );
    expect(screen.getByText('مستودع التبريد')).toBeInTheDocument();
    expect(screen.getByText('معطّل')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('sorts, filters and searches on the server and keeps the state in the URL', async () => {
    const server = session(FULL, {
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([W1, W2]),
      'GET /warehouses?page=1&pageSize=25&sort=name&dir=asc': () => listBody([W2, W1]),
      'GET /warehouses?page=1&pageSize=25&sort=name&dir=asc&q=cold': () => listBody([W2]),
    });
    await renderApp('/warehouses');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: 'MAIN' });
    await u.click(screen.getByRole('button', { name: /الاسم/ }));
    await waitFor(() =>
      expect(listKey(server.calls)).toContain(
        'GET /warehouses?page=1&pageSize=25&sort=name&dir=asc',
      ),
    );
    await u.type(screen.getByLabelText('بحث'), 'cold');
    await waitFor(() =>
      expect(listKey(server.calls)).toContain(
        'GET /warehouses?page=1&pageSize=25&sort=name&dir=asc&q=cold',
      ),
    );
    expect(await screen.findByText('مستودع التبريد')).toBeInTheDocument();
    expect(screen.queryByText('المستودع الرئيسي')).not.toBeInTheDocument();
  });

  it('starts from the state in the URL (page, filter)', async () => {
    const server = session(FULL, {
      'GET /warehouses?page=2&pageSize=25&sort=code&dir=desc&active=false': () =>
        listBody([W2], 30, 2),
    });
    await renderApp('/warehouses?page=2&active=false&dir=desc');
    await screen.findByText('مستودع التبريد');
    expect(listKey(server.calls)).toEqual([
      'GET /warehouses?page=2&pageSize=25&sort=code&dir=desc&active=false',
    ]);
  });

  it('pages on the server: the page control asks for the next page', async () => {
    const server = session(FULL, {
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([W1], 30, 2),
      'GET /warehouses?page=2&pageSize=25&sort=code&dir=asc': () => listBody([W2], 30, 2),
    });
    await renderApp('/warehouses');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: 'MAIN' });
    await u.click(screen.getByRole('button', { name: '2' }));
    expect(await screen.findByRole('link', { name: 'COLD' })).toBeInTheDocument();
    expect(listKey(server.calls)).toContain('GET /warehouses?page=2&pageSize=25&sort=code&dir=asc');
  });

  it('hides the add button without the create permission', async () => {
    session(['inventory.warehouse.read'], {
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([W1]),
    });
    await renderApp('/warehouses');
    await screen.findByRole('link', { name: 'MAIN' });
    expect(screen.queryByRole('button', { name: 'إضافة مستودع' })).not.toBeInTheDocument();
  });

  it('validates the code before calling the server, then creates and reports a taken code', async () => {
    let taken = true;
    const server = session(FULL, {
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([W1]),
      'POST /warehouses': () => (taken ? fail(409, 'WAREHOUSE_CODE_TAKEN') : ok(W2)),
    });
    await renderApp('/warehouses');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إضافة مستودع' }));
    const dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/الاسم/), 'جديد');
    await u.type(within(dialog).getByLabelText(/الرمز/), 'bad code!');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText(/رمز غير صالح/)).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /warehouses')).toBe(false);

    await u.clear(within(dialog).getByLabelText(/الرمز/));
    await u.type(within(dialog).getByLabelText(/الرمز/), 'NEW-1');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'هذا الرمز مستعمل لمستودع آخر',
    );

    taken = false;
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = server.calls.filter((c) => c.key === 'POST /warehouses');
    expect(posts.at(-1)?.body).toEqual({ code: 'NEW-1', name: 'جديد' });
  });
});

describe('warehouse detail', () => {
  const detail = (over: Record<string, Handler> = {}) =>
    session(FULL, {
      'GET /warehouses/w1': () => ok(W1),
      'GET /warehouses/w1/locations': () => ok([L1]),
      ...over,
    });

  it('shows the warehouse and its locations, with no a11y violations', async () => {
    detail();
    const { container } = await renderApp('/warehouses/w1');
    expect(await screen.findByText('A-01')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('MAIN — المستودع الرئيسي');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an unreachable warehouse shows one not-found message', async () => {
    session(FULL, { 'GET /warehouses/zz': () => fail(404, 'NOT_FOUND') });
    await renderApp('/warehouses/zz');
    expect(await screen.findByText('المستودع غير موجود')).toBeInTheDocument();
  });

  it('read-only users see no write buttons', async () => {
    session(['inventory.warehouse.read'], {
      'GET /warehouses/w1': () => ok(W1),
      'GET /warehouses/w1/locations': () => ok([L1]),
    });
    await renderApp('/warehouses/w1');
    await screen.findByText('A-01');
    for (const name of ['تعديل', 'حذف', 'إضافة موقع'])
      expect(screen.queryByRole('button', { name: new RegExp(name) })).not.toBeInTheDocument();
  });

  it('edits the warehouse with its version and explains a version conflict', async () => {
    let conflict = true;
    const server = detail({
      'PATCH /warehouses/w1': () =>
        conflict ? fail(409, 'VERSION_CONFLICT') : ok({ ...W1, name: 'اسم جديد', version: 4 }),
    });
    await renderApp('/warehouses/w1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/الاسم/);
    await u.clear(name);
    await u.type(name, 'اسم جديد');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('عدّل شخص آخر');
    conflict = false;
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const patches = server.calls.filter((c) => c.key === 'PATCH /warehouses/w1');
    expect(patches.at(-1)?.body).toEqual({ name: 'اسم جديد', active: true, version: 3 });
  });

  it('adds and edits a location (edit sends the location version, never the code)', async () => {
    const server = detail({
      'POST /warehouses/w1/locations': () => ok({ ...L1, id: 'l2', code: 'B-02' }),
      'PATCH /warehouses/w1/locations/l1': () => ok(L1),
    });
    await renderApp('/warehouses/w1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إضافة موقع' }));
    let dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText(/الرمز/), 'B-02');
    await u.type(within(dialog).getByLabelText(/الاسم/), 'رف ب2');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.key === 'POST /warehouses/w1/locations')?.body).toEqual({
      code: 'B-02',
      name: 'رف ب2',
    });

    await u.click(screen.getByRole('button', { name: 'تعديل A-01' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/الرمز/)).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.find((c) => c.key === 'PATCH /warehouses/l1')).toBeUndefined();
    expect(server.calls.find((c) => c.key === 'PATCH /warehouses/w1/locations/l1')?.body).toEqual({
      version: 2,
      name: 'رف أ1',
      active: true,
    });
  });

  it('deleting a warehouse needs confirmation that shows the impact, and nothing is sent on cancel', async () => {
    const server = detail({
      'DELETE /warehouses/w1': () => ok({ deleted: true }),
      'GET /warehouses?page=1&pageSize=25&sort=code&dir=asc': () => listBody([]),
    });
    await renderApp('/warehouses/w1');
    const u = userEvent.setup();
    await screen.findByText('A-01');
    await u.click(screen.getByRole('button', { name: 'حذف' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('MAIN');
    expect(dialog).toHaveTextContent('1 موقع');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.some((c) => c.key === 'DELETE /warehouses/w1')).toBe(false);

    await u.click(screen.getByRole('button', { name: 'حذف' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'حذف' }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.key === 'DELETE /warehouses/w1')).toBe(true),
    );
    expect(await screen.findByRole('heading', { name: 'المستودعات' })).toBeInTheDocument();
  });
});
