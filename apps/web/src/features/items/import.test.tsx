import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from '../../test/helpers';
import type { Handler } from '../../test/helpers';

afterEach(() => vi.unstubAllGlobals());

const REPORT = {
  mode: 'preview',
  totalRows: 5,
  validRows: 4,
  created: 3,
  updated: 1,
  unchanged: 0,
  skipped: 0,
  errorsTotal: 1,
  errors: [{ line: 4, field: 'price', code: 'INVALID_VALUE', message: 'Invalid' }],
  errorsTruncated: false,
  ignoredColumns: ['color'],
};
const CLEAN = {
  ...REPORT,
  errorsTotal: 0,
  errors: [],
  validRows: 5,
  created: 4,
  ignoredColumns: [],
};
const CSV = 'barcode,name\n1,a\n2,b\n';
const IMPORT = ['inventory.item.read', 'inventory.item.import'];

const session = (permissions: string[], extra: Record<string, Handler> = {}) =>
  fakeServer({
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions }),
    'GET /items?page=1&pageSize=25&sort=name&dir=asc': () => ({
      body: { data: [], meta: { page: 1, pageSize: 25, total: 0, totalPages: 1 } },
    }),
    ...extra,
  });
const upload = async (u: ReturnType<typeof userEvent.setup>, name = 'items.csv', body = CSV) => {
  await screen.findByText('ملف CSV');
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await u.upload(input, new File([body], name, { type: 'text/csv' }));
};
const posts = (calls: { key: string; body: unknown }[]) =>
  calls.filter((c) => c.key.startsWith('POST /items/import'));

describe('items import', () => {
  it('hides the entry link without the import permission', async () => {
    session(['inventory.item.read']);
    await renderApp('/items');
    await screen.findByRole('heading', { name: 'الأصناف' });
    expect(screen.queryByRole('link', { name: 'استيراد من CSV' })).not.toBeInTheDocument();
  });

  it('sends a user without the permission from the import page back to the list', async () => {
    session(['inventory.item.read']);
    await renderApp('/items/import');
    expect(await screen.findByRole('heading', { name: 'الأصناف' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'استيراد الأصناف من CSV' }),
    ).not.toBeInTheDocument();
  });

  it('shows the entry link with the permission', async () => {
    session(IMPORT);
    await renderApp('/items');
    expect(await screen.findByRole('link', { name: 'استيراد من CSV' })).toHaveAttribute(
      'href',
      '/items/import',
    );
  });

  it('the import page has no a11y violations', async () => {
    session(IMPORT);
    const { container } = await renderApp('/items/import');
    expect(
      await screen.findByRole('heading', { name: 'استيراد الأصناف من CSV' }),
    ).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('downloads the template without calling the server', async () => {
    const server = session(IMPORT);
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await renderApp('/items/import');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'تنزيل القالب' }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalled();
    expect(server.calls.some((c) => c.key.includes('template'))).toBe(false);
    click.mockRestore();
  });

  it('rejects a wrong extension before any request, and keeps preview disabled', async () => {
    const server = session(IMPORT);
    await renderApp('/items/import');
    const u = userEvent.setup({ applyAccept: false });
    await upload(u, 'items.xlsx');
    expect(await screen.findByText('اختر ملفاً بصيغة CSV')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'معاينة' })).toBeDisabled();
    expect(posts(server.calls)).toHaveLength(0);
  });

  it('previews as raw CSV text, lists row errors, and blocks apply until errors are fixed or skipped', async () => {
    const server = session(IMPORT, {
      'POST /items/import?mode=preview&skipInvalid=false': () => ok(REPORT),
      'POST /items/import?mode=preview&skipInvalid=true': () => ok({ ...REPORT, skipped: 1 }),
    });
    await renderApp('/items/import');
    const u = userEvent.setup();
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    expect(await screen.findByText('قيمة غير صالحة')).toBeInTheDocument();
    expect(posts(server.calls)[0]?.body).toBe(CSV);
    expect(screen.getByText(/color/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تطبيق الاستيراد' })).toBeDisabled();
    expect(screen.getByText(/صحّحها أو فعّل/)).toBeInTheDocument();

    await u.click(screen.getByLabelText(/تجاوز الصفوف الخاطئة/));
    // تغيير الخيار يبطل المعاينة القديمة. Toggling voids the old preview.
    expect(screen.queryByText('قيمة غير صالحة')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تطبيق الاستيراد' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    await screen.findByText('قيمة غير صالحة');
    expect(posts(server.calls).at(-1)?.key).toBe(
      'POST /items/import?mode=preview&skipInvalid=true',
    );
    expect(screen.getByRole('button', { name: 'تطبيق الاستيراد' })).toBeEnabled();
  });

  it('apply needs a confirmation that states the impact; cancel writes nothing; confirm applies once', async () => {
    const server = session(IMPORT, {
      'POST /items/import?mode=preview&skipInvalid=false': () => ok(CLEAN),
      'POST /items/import?mode=apply&skipInvalid=false': () => ok({ ...CLEAN, mode: 'apply' }),
    });
    await renderApp('/items/import');
    const u = userEvent.setup();
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    await u.click(await screen.findByRole('button', { name: 'تطبيق الاستيراد' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('سيُنشأ 4 صنف ويُحدَّث 1 صنف');
    await u.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(server.calls).filter((c) => c.key.includes('mode=apply'))).toHaveLength(0);

    await u.click(screen.getByRole('button', { name: 'تطبيق الاستيراد' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'تطبيق الاستيراد' }),
    );
    expect(await screen.findByText('تم الاستيراد')).toBeInTheDocument();
    expect(posts(server.calls).filter((c) => c.key.includes('mode=apply'))).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'عرض الأصناف' })).toBeInTheDocument();
  });

  it('shows translated file-level errors, never the server text', async () => {
    session(IMPORT, {
      'POST /items/import?mode=preview&skipInvalid=false': () =>
        fail(422, 'IMPORT_MISSING_COLUMNS'),
    });
    await renderApp('/items/import');
    const u = userEvent.setup();
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('أعمدة إلزامية ناقصة');
    expect(screen.queryByText('IMPORT_MISSING_COLUMNS')).not.toBeInTheDocument();
  });

  it('an apply refused for invalid rows shows the report that came with the refusal', async () => {
    session(IMPORT, {
      'POST /items/import?mode=preview&skipInvalid=false': () => ok({ ...CLEAN, errorsTotal: 0 }),
      'POST /items/import?mode=apply&skipInvalid=false': () => ({
        status: 422,
        body: {
          error: {
            code: 'IMPORT_INVALID',
            status: 422,
            message: 'x',
            details: REPORT,
            requestId: 'r',
          },
        },
      }),
    });
    await renderApp('/items/import');
    const u = userEvent.setup();
    await upload(u);
    await u.click(screen.getByRole('button', { name: 'معاينة' }));
    await u.click(await screen.findByRole('button', { name: 'تطبيق الاستيراد' }));
    await u.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'تطبيق الاستيراد' }),
    );
    expect(await screen.findByText('قيمة غير صالحة')).toBeInTheDocument();
    expect((await screen.findAllByText(/ولم يُكتب شيء/)).length).toBeGreaterThan(0);
  });
});
