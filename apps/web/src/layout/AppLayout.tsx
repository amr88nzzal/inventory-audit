import {
  AppShell,
  Burger,
  Button,
  Group,
  NavLink,
  SegmentedControl,
  Text,
  useDirection,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { applyLang, dirOf } from '../i18n';
import type { Lang } from '../i18n';
import { useAuth } from '../auth/AuthProvider';
import { NAV_ITEMS } from './nav';
import { useCan } from '../auth/AuthProvider';

export const AppLayout = () => {
  const { t, i18n } = useTranslation();
  const { logout, state } = useAuth();
  const can = useCan();
  const [opened, { toggle }] = useDisclosure();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { setDirection } = useDirection();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const lang = (i18n.language === 'en' ? 'en' : 'ar') as Lang;

  const changeLang = (next: string): void => {
    const l: Lang = next === 'en' ? 'en' : 'ar';
    void i18n.changeLanguage(l);
    applyLang(l);
    setDirection(dirOf(l));
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      <a href="#main" className="skip-link">
        {t('common.skip')}
      </a>
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap">
            <Burger
              opened={opened}
              onClick={toggle}
              hiddenFrom="sm"
              size="sm"
              aria-label={t('nav.main')}
            />
            <Text fw={700}>{t('app.name')}</Text>
          </Group>
          <Group wrap="nowrap" gap="xs">
            <SegmentedControl
              size="xs"
              aria-label={t('common.language')}
              value={lang}
              onChange={changeLang}
              data={[
                { value: 'ar', label: t('common.arabic') },
                { value: 'en', label: t('common.english') },
              ]}
            />
            <SegmentedControl
              size="xs"
              aria-label={t('common.theme.label')}
              value={colorScheme}
              onChange={(v) =>
                setColorScheme(v === 'dark' ? 'dark' : v === 'light' ? 'light' : 'auto')
              }
              data={[
                { value: 'light', label: t('common.theme.light') },
                { value: 'dark', label: t('common.theme.dark') },
                { value: 'auto', label: t('common.theme.auto') },
              ]}
            />
            <Text size="sm" visibleFrom="sm">
              {state.status === 'authed' ? state.user.displayName : ''}
            </Text>
            <Button variant="default" size="xs" onClick={() => void logout()}>
              {t('common.logout')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" aria-label={t('nav.main')}>
        {NAV_ITEMS.filter((i) => !i.permission || can(i.permission)).map((i) => (
          <NavLink
            key={i.to}
            component={Link}
            to={i.to}
            label={t(i.labelKey)}
            active={i.to === '/' ? path === '/' : path.startsWith(i.to)}
          />
        ))}
      </AppShell.Navbar>
      <AppShell.Main id="main" tabIndex={-1}>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
};
