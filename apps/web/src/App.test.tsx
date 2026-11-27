import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fail, fakeServer, ok, renderApp, user } from './test/helpers';

afterEach(() => vi.unstubAllGlobals());

const signedOut = { 'POST /auth/refresh': () => fail(401, 'INVALID_REFRESH') };
const fillLogin = async (u: ReturnType<typeof userEvent.setup>, pw = 'secret-password-1') => {
  await u.type(await screen.findByLabelText(/رمز الشركة/), 'demo');
  await u.type(screen.getByLabelText(/اسم المستخدم/), 'demo.admin');
  await u.type(screen.getByLabelText(/كلمة المرور/), pw);
  await u.click(screen.getByRole('button', { name: 'دخول' }));
};

describe('sign-in', () => {
  it('sends a visitor without a session to the login page, which has no a11y violations', async () => {
    fakeServer(signedOut);
    const { container } = await renderApp('/');
    expect(await screen.findByRole('heading', { name: 'تسجيل الدخول' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('validates before calling the server', async () => {
    const server = fakeServer(signedOut);
    await renderApp('/login');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'دخول' }));
    expect(await screen.findByText(/رمز الشركة من 3 إلى 32/)).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /auth/login')).toBe(false);
  });

  it('signs in, loads permissions and shows the home page', async () => {
    const server = fakeServer({
      ...signedOut,
      'POST /auth/login': () => ok({ accessToken: 'tok', user: user() }),
      'GET /permissions/mine': () =>
        ok({ permissions: ['inventory.task.read', 'inventory.item.read'] }),
    });
    await renderApp('/login');
    await fillLogin(userEvent.setup());
    expect(await screen.findByText('مرحباً، مدير تجريبي')).toBeInTheDocument();
    expect(screen.getByText('عدد صلاحياتك: 2')).toBeInTheDocument();
    const login = server.calls.find((c) => c.key === 'POST /auth/login');
    expect(login?.body).toEqual({
      companyCode: 'demo',
      username: 'demo.admin',
      password: 'secret-password-1',
    });
  });

  it('shows a translated message, never the raw server text, for wrong credentials and lockout', async () => {
    let code = 'INVALID_CREDENTIALS';
    fakeServer({ ...signedOut, 'POST /auth/login': () => fail(401, code) });
    await renderApp('/login');
    const u = userEvent.setup();
    await fillLogin(u, 'wrong-password-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('بيانات الدخول غير صحيحة');
    code = 'ACCOUNT_LOCKED';
    await u.click(screen.getByRole('button', { name: 'دخول' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('الحساب مقفل مؤقتاً'));
    expect(screen.queryByText('ACCOUNT_LOCKED')).not.toBeInTheDocument();
  });

  it('a surviving refresh cookie restores the session on page load', async () => {
    fakeServer({
      'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
      'GET /auth/me': () => ok(user()),
      'GET /permissions/mine': () => ok({ permissions: [] }),
    });
    await renderApp('/');
    expect(await screen.findByText('مرحباً، مدير تجريبي')).toBeInTheDocument();
  });

  it('a temporary password is forced to the change-password page before anything else', async () => {
    const server = fakeServer({
      ...signedOut,
      'POST /auth/login': () =>
        ok({ accessToken: 'tok', user: user({ mustChangePassword: true }) }),
      'POST /auth/change-password': () => ok(null),
      'GET /permissions/mine': () => ok({ permissions: [] }),
    });
    await renderApp('/login');
    const u = userEvent.setup();
    await fillLogin(u, 'Temp-password-123');
    expect(await screen.findByRole('heading', { name: 'تغيير كلمة المرور' })).toBeInTheDocument();
    // لا طلب صلاحيات قبل التغيير. No permissions request before the change.
    expect(server.calls.some((c) => c.key === 'GET /permissions/mine')).toBe(false);
    await u.type(screen.getByLabelText(/كلمة المرور الحالية/), 'Temp-password-123');
    await u.type(screen.getByLabelText(/^كلمة المرور الجديدة/), 'A-much-better-pass-9');
    await u.type(screen.getByLabelText(/تأكيد/), 'A-much-better-pass-9');
    await u.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(/مرحباً/)).toBeInTheDocument();
    expect(server.calls.find((c) => c.key === 'POST /auth/change-password')?.body).toEqual({
      currentPassword: 'Temp-password-123',
      newPassword: 'A-much-better-pass-9',
    });
  });

  it('change-password validates locally: short, mismatch, same as current', async () => {
    const server = fakeServer({
      ...signedOut,
      'POST /auth/login': () =>
        ok({ accessToken: 'tok', user: user({ mustChangePassword: true }) }),
    });
    await renderApp('/login');
    const u = userEvent.setup();
    await fillLogin(u, 'Temp-password-123');
    await screen.findByRole('heading', { name: 'تغيير كلمة المرور' });
    await u.type(screen.getByLabelText(/كلمة المرور الحالية/), 'Temp-password-123');
    await u.type(screen.getByLabelText(/^كلمة المرور الجديدة/), 'short');
    await u.type(screen.getByLabelText(/تأكيد/), 'other');
    await u.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText('12 حرفاً على الأقل')).toBeInTheDocument();
    expect(screen.getByText('كلمتا المرور غير متطابقتين')).toBeInTheDocument();
    expect(server.calls.some((c) => c.key === 'POST /auth/change-password')).toBe(false);
  });
});

describe('route guards', () => {
  it('a restored session that still has a temporary password cannot reach the app, only change-password', async () => {
    fakeServer({
      'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
      'GET /auth/me': () => ok(user({ mustChangePassword: true })),
    });
    await renderApp('/');
    expect(await screen.findByRole('heading', { name: 'تغيير كلمة المرور' })).toBeInTheDocument();
    expect(screen.queryByText(/مرحباً/)).not.toBeInTheDocument();
  });

  it('an authenticated user opening /login is sent to the app', async () => {
    fakeServer({
      'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
      'GET /auth/me': () => ok(user()),
      'GET /permissions/mine': () => ok({ permissions: [] }),
    });
    await renderApp('/login');
    expect(await screen.findByText('مرحباً، مدير تجريبي')).toBeInTheDocument();
  });
});

describe('app shell', () => {
  const session = {
    'POST /auth/refresh': () => ok({ accessToken: 'tok' }),
    'GET /auth/me': () => ok(user()),
    'GET /permissions/mine': () => ok({ permissions: ['inventory.task.read'] }),
    'POST /auth/logout': () => ok(null),
  };

  it('has a skip link, labelled navigation, no a11y violations, and signs out', async () => {
    fakeServer(session);
    const { container } = await renderApp('/');
    await screen.findByText('مرحباً، مدير تجريبي');
    expect(screen.getByRole('link', { name: 'تخطَّ إلى المحتوى' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('navigation', { name: 'القائمة الرئيسية' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    await userEvent.setup().click(screen.getByRole('button', { name: 'تسجيل الخروج' }));
    expect(await screen.findByRole('heading', { name: 'تسجيل الدخول' })).toBeInTheDocument();
  });

  it('switches to English and flips the direction without losing the session', async () => {
    fakeServer(session);
    await renderApp('/');
    await screen.findByText('مرحباً، مدير تجريبي');
    await userEvent.setup().click(screen.getByText('English'));
    expect(await screen.findByText('Welcome, مدير تجريبي')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });
});
