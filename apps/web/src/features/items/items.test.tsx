import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const I1 = {
  id: 'i1',
  barcode: '6290001',
  sku: 'SKU-1',
  name: 'حليب كامل الدسم',
  price: '1.2500',
  supplier: 'المراعي',
  category: 'ألبان',
  accountNo: null,
  baseUnit: 'علبة',
  tolerancePct: '2',
  active: true,
  version: 4,
  units: [{ name: 'كرتون', factor: '12' }],
  createdAt: '2026-01-01T00:00:00Z',
};
const I2 = { ...I1, id: 'i2', barcode: '6290002', name: 'عصير برتقال', units: [], active: false };
const FULL = [
  'inventory.item.read',
  'inventory.item.create',
  'inventory.item.update',
  'inventory.item.delete',
];
const BASE = 'GET /items?page=1&pageSize=25&sort=name&dir=asc';
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
const listKeys = (calls: { key: string }[]) =>
  calls.filter((c) => c.key.startsWith('GET /items?')).map((c) => c.key);

describe('items list', () => {
  it('hides the menu item without the read permission', async () => {
    session([], { [BASE]: () => listBody([]) });
    await renderApp('/');
    await screen.findByText('مرحباً، مدير تجريبي');
    expect(screen.queryByRole('link', { name: 'الأصناف' })).not.toBeInTheDocument();
  });

  it('lists items with no a11y violations', async () => {
    session(FULL, { [BASE]: () => listBody([I1, I2]) });
    const { container } = await renderApp('/items');
    expect(await screen.findByRole('link', { name: '6290001' })).toHaveAttribute(
      'href',
      '/items/i1',
    );
    expect(screen.getByText('عصير برتقال')).toBeInTheDocument();
    expect(screen.getAllByText('1.2500')).toHaveLength(2);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('sorts on the server by the clicked column', async () => {
    const server = session(FULL, {
      [BASE]: () => listBody([I1, I2]),
      'GET /items?page=1&pageSize=25&sort=price&dir=asc': () => listBody([I2, I1]),
    });
    await renderApp('/items');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: '6290001' });
    await u.click(screen.getByRole('button', { name: /السعر/ }));
    await waitFor(() =>
      expect(listKeys(server.calls)).toContain('GET /items?page=1&pageSize=25&sort=price&dir=asc'),
    );
  });

  it('reads page, filters and a numeric q from the URL', async () => {
    const server = session(FULL, {
      'GET /items?page=3&pageSize=25&sort=barcode&dir=desc&q=629&category=x&active=true': () =>
        listBody([I1], 60, 3),
    });
    await renderApp('/items?page=3&sort=barcode&dir=desc&q=629&category=x&active=true');
    await screen.findByRole('link', { name: '6290001' });
    expect(listKeys(server.calls)).toEqual([
      'GET /items?page=3&pageSize=25&sort=barcode&dir=desc&q=629&category=x&active=true',
    ]);
  });

  it('searching sends q after typing pauses and resets to page 1', async () => {
    const server = session(FULL, {
      [BASE]: () => listBody([I1, I2]),
      [`${BASE}&q=${encodeURIComponent('عصير')}`]: () => listBody([I2]),
    });
    await renderApp('/items');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: '6290001' });
    await u.type(screen.getByLabelText('بحث'), 'عصير');
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: '6290001' })).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('link', { name: '6290002' })).toBeInTheDocument();
    expect(listKeys(server.calls).at(-1)).toContain('page=1');
  });

  it('pages on the server', async () => {
    const server = session(FULL, {
      [BASE]: () => listBody([I1], 30, 2),
      'GET /items?page=2&pageSize=25&sort=name&dir=asc': () => listBody([I2], 30, 2),
    });
    await renderApp('/items');
    const u = userEvent.setup();
    await screen.findByRole('link', { name: '6290001' });
    await u.click(screen.getByRole('button', { name: '2' }));
    expect(await screen.findByRole('link', { name: '6290002' })).toBeInTheDocument();
    expect(listKeys(server.calls)).toContain('GET /items?page=2&pageSize=25&sort=name&dir=asc');
  });

  it('hides the add button without the create permission', async () => {
    session(['inventory.item.read'], { [BASE]: () => listBody([I1]) });
    await renderApp('/items');
    await screen.findByRole('link', { name: '6290001' });
    expect(screen.queryByRole('button', { name: 'إضافة صنف' })).not.toBeInTheDocument();
  });

  it('validates with the server rules before posting, reports a taken barcode, then sends a clean payload', async () => {
    let taken = true;
    const server = session(FULL, {
      [BASE]: () => listBody([I1]),
      'POST /items': () => (taken ? fail(409, 'BARCODE_TAKEN') : ok(I2)),
    });
    await renderApp('/items');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'إضافة صنف' }));
    const dialog = await screen.findByRole('dialog');
    const f = (label: RegExp) => within(dialog).getByLabelText(label);
    await u.type(f(/الباركود/), '6290009');
    await u.type(f(/^الاسم/), 'شاي');
    await u.type(f(/السعر/), 'abc');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText('قيمة غير صالحة')).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /items')).toBe(false);

    await u.clear(f(/السعر/));
    await u.type(f(/السعر/), '2.5');
    await u.click(within(dialog).getByRole('button', { name: 'إضافة وحدة' }));
    await u.type(f(/اسم الوحدة 1/), 'كرتون');
    await u.type(f(/معامل الوحدة 1/), '1');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByText('المعامل رقم أكبر من 1')).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /items')).toBe(false);

    await u.clear(f(/معامل الوحدة 1/));
    await u.type(f(/معامل الوحدة 1/), '24');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'هذا الباركود مستعمل لصنف آخر',
    );

    taken = false;
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.filter((c) => c.key === 'POST /items').at(-1)?.body).toEqual({
      barcode: '6290009',
      name: 'شاي',
      price: '2.5',
      units: [{ name: 'كرتون', factor: '24' }],
    });
  });
});

describe('item detail', () => {
  const detail = (over: Record<string, Handler> = {}) =>
    session(FULL, { 'GET /items/i1': () => ok(I1), ...over });

  it('shows the item and its units with no a11y violations', async () => {
    detail();
    const { container } = await renderApp('/items/i1');
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('حليب كامل الدسم');
    expect(screen.getByText('كرتون')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows one not-found message for a missing or out-of-reach item', async () => {
    session(FULL, { 'GET /items/zz': () => fail(404, 'NOT_FOUND') });
    await renderApp('/items/zz');
    expect(await screen.findByText('الصنف غير موجود')).toBeInTheDocument();
  });

  it('read-only users see no write buttons', async () => {
    session(['inventory.item.read'], { 'GET /items/i1': () => ok(I1) });
    await renderApp('/items/i1');
    await screen.findByText('كرتون');
    expect(screen.queryByRole('button', { name: 'تعديل' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'حذف' })).not.toBeInTheDocument();
  });

  it('edit sends the version, null for a cleared optional field, and explains a conflict', async () => {
    let conflict = true;
    const server = detail({
      'PATCH /items/i1': () =>
        conflict ? fail(409, 'VERSION_CONFLICT') : ok({ ...I1, version: 5 }),
    });
    await renderApp('/items/i1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText(/المورّد/));
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('عدّل شخص آخر');
    conflict = false;
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const body = server.calls.filter((c) => c.key === 'PATCH /items/i1').at(-1)?.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      version: 4,
      supplier: null,
      accountNo: null,
      sku: 'SKU-1',
      active: true,
      barcode: '6290001',
      units: [{ name: 'كرتون', factor: '12' }],
    });
  });

  it('a duplicate unit name is rejected before any request; a base-unit clash comes back from the server as a message', async () => {
    let clash = false;
    const server = detail({
      'PATCH /items/i1': () => (clash ? fail(400, 'VALIDATION_ERROR') : ok(I1)),
    });
    await renderApp('/items/i1');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'تعديل' }));
    const dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('button', { name: 'إضافة وحدة' }));
    await u.type(within(dialog).getByLabelText(/اسم الوحدة 2/), 'كرتون');
    await u.type(within(dialog).getByLabelText(/معامل الوحدة 2/), '6');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('تحقق من الوحدات');
    expect(server.calls.some((c) => c.key === 'PATCH /items/i1')).toBe(false);

    clash = true;
    await u.clear(within(dialog).getByLabelText(/اسم الوحدة 2/));
    await u.type(within(dialog).getByLabelText(/اسم الوحدة 2/), 'علبة');
    await u.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(server.calls.filter((c) => c.key === 'PATCH /items/i1')).toHaveLength(1),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('تحقق من الوحدات');
  });

  it('delete needs confirmation, and cancel sends nothing', async () => {
    const server = detail({
      'DELETE /items/i1': () => ok({ deleted: true }),
      [BASE]: () => listBody([]),
    });
    await renderApp('/items/i1');
    const u = userEvent.setup();
    await screen.findByText('كرتون');
    await u.click(screen.getByRole('button', { name: 'حذف' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('6290001');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(server.calls.some((c) => c.key === 'DELETE /items/i1')).toBe(false);

    await u.click(screen.getByRole('button', { name: 'حذف' }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'حذف' }));
    await waitFor(() => expect(server.calls.some((c) => c.key === 'DELETE /items/i1')).toBe(true));
    expect(await screen.findByRole('heading', { name: 'الأصناف' })).toBeInTheDocument();
  });
});
