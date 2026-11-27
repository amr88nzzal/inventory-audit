import '@fontsource-variable/noto-sans-arabic';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './styles.css';
import { DirectionProvider, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { dirOf, setupI18n } from './i18n';
import type { Lang } from './i18n';
import { theme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

// الاتجاه الابتدائي من اللغة المحفوظة، ويتبدّل لاحقاً من القائمة دون إعادة تركيب التطبيق.
// The initial direction comes from the saved language and later changes from the menu without remounting the app.
const Providers = ({ lang }: { lang: Lang }) => (
  <DirectionProvider initialDirection={dirOf(lang)} detectDirection={false}>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <Notifications />
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </MantineProvider>
  </DirectionProvider>
);

void setupI18n().then((i18n) => {
  createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <Providers lang={i18n.language === 'en' ? 'en' : 'ar'} />
      </I18nextProvider>
    </StrictMode>,
  );
});
