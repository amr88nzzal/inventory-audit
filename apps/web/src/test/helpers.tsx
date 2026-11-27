import { DirectionProvider, MantineProvider } from '@mantine/core';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { vi } from 'vitest';
import { App } from '../App';
import { setAccessToken } from '../api/client';
import { AuthProvider } from '../auth/AuthProvider';
import { i18n, setupI18n } from '../i18n';
import { theme } from '../theme';

// محاكاة الخادم: جدول مسارات → استجابة. A fake server: a route table → a response.
export type Handler = (body: unknown, init: RequestInit) => { status?: number; body?: unknown };
export const fakeServer = (routes: Record<string, Handler>) => {
  const calls: { key: string; body: unknown }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = String(url).replace('/api/v1', '');
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ key, body });
    const h = routes[key];
    if (!h)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } }), {
        status: 404,
      });
    const out = h(body, init);
    return new Response(JSON.stringify(out.body ?? { data: null, meta: {} }), {
      status: out.status ?? 200,
    });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
};

export const ok = (data: unknown) => ({ body: { data, meta: {} } });
export const fail = (status: number, code: string) => ({
  status,
  body: { error: { code, status, message: code, details: null, requestId: 'r' } },
});
export const user = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  companyId: 'c1',
  username: 'demo.admin',
  displayName: 'مدير تجريبي',
  mustChangePassword: false,
  ...over,
});

export const renderApp = async (path = '/', lang: 'ar' | 'en' = 'ar') => {
  setAccessToken(null);
  await setupI18n(lang);
  const history = createMemoryHistory({ initialEntries: [path] });
  return render(
    <I18nextProvider i18n={i18n}>
      <DirectionProvider initialDirection={lang === 'ar' ? 'rtl' : 'ltr'} detectDirection={false}>
        <MantineProvider theme={theme} defaultColorScheme="light">
          <AuthProvider>
            <App history={history} />
          </AuthProvider>
        </MantineProvider>
      </DirectionProvider>
    </I18nextProvider>,
  );
};
