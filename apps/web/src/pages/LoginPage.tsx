import { loginSchema } from '@inventory/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Paper, PasswordInput, Stack, TextInput, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { errorKey } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';

type Values = z.input<typeof loginSchema>;

const ERRORS = {
  INVALID_CREDENTIALS: 'login.invalidCredentials',
  ACCOUNT_LOCKED: 'login.locked',
  RATE_LIMITED: 'login.tooMany',
};

export const LoginPage = () => {
  const { t } = useTranslation();
  const { login, state } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const remembered = state.status === 'authed' ? state.companyCode : '';
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(loginSchema),
    defaultValues: { companyCode: remembered, username: '', password: '' },
  });

  const submit = handleSubmit(async (values) => {
    setError(null);
    try {
      await login({
        companyCode: values.companyCode.trim().toLowerCase(),
        username: values.username.trim(),
        password: values.password,
      });
    } catch (e) {
      setError(errorKey(e, ERRORS));
    }
  });

  return (
    <Paper component="main" withBorder shadow="sm" p="xl" maw={420} mx="auto" mt="10vh">
      <form onSubmit={submit} noValidate>
        <Stack>
          <Title order={1} size="h2">
            {t('login.title')}
          </Title>
          {error && (
            <Alert color="red" role="alert">
              {t(error)}
            </Alert>
          )}
          <TextInput
            label={t('login.company')}
            autoComplete="organization"
            dir="ltr"
            required
            error={errors.companyCode ? t('login.companyInvalid') : undefined}
            {...register('companyCode')}
          />
          <TextInput
            label={t('login.username')}
            autoComplete="username"
            dir="ltr"
            required
            error={errors.username ? t('login.required') : undefined}
            {...register('username')}
          />
          <PasswordInput
            label={t('login.password')}
            autoComplete="current-password"
            required
            error={errors.password ? t('login.required') : undefined}
            {...register('password')}
          />
          <Button type="submit" loading={isSubmitting}>
            {t('login.submit')}
          </Button>
        </Stack>
      </form>
    </Paper>
  );
};
