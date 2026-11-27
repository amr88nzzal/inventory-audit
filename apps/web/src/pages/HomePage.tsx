import { Card, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthProvider';

export const HomePage = () => {
  const { t } = useTranslation();
  const { state } = useAuth();
  if (state.status !== 'authed') return null;
  return (
    <Stack>
      <Title order={1} size="h2">
        {t('home.title')}
      </Title>
      <Card withBorder>
        <Stack gap="xs">
          <Text fw={600}>{t('home.welcome', { name: state.user.displayName })}</Text>
          <Text c="dimmed">{t('home.company', { code: state.companyCode })}</Text>
          <Text c="dimmed">{t('home.permissions', { count: state.permissions.size })}</Text>
        </Stack>
      </Card>
      <Text c="dimmed">{t('home.soon')}</Text>
    </Stack>
  );
};
