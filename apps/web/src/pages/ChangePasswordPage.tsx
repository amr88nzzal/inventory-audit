import { newPasswordSchema } from '@inventory/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api } from '../api/client';
import { errorKey } from '../api/errors';
import { useAuth } from '../auth/AuthProvider';

// التأكيد والاختلاف عن الحالية يُفحصان هنا، والخادم يعيد فحصهما. Confirmation and "differs from current" are checked here; the server checks them again.
const schema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: newPasswordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'mismatch' })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ['newPassword'], message: 'same' });
type Values = z.input<typeof schema>;

export const ChangePasswordPage = () => {
  const { t } = useTranslation();
  const { markPasswordChanged } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  const newError = errors.newPassword
    ? errors.newPassword.message === 'same'
      ? t('changePassword.same')
      : t('changePassword.tooShort')
    : undefined;

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await api.post('/auth/change-password', {
        currentPassword: v.currentPassword,
        newPassword: v.newPassword,
      });
      markPasswordChanged();
    } catch (e) {
      setError(errorKey(e, { INVALID_CREDENTIALS: 'changePassword.wrongCurrent' }));
    }
  });

  return (
    <Paper component="main" withBorder shadow="sm" p="xl" maw={460} mx="auto" mt="10vh">
      <form onSubmit={submit} noValidate>
        <Stack>
          <Title order={1} size="h2">
            {t('changePassword.title')}
          </Title>
          <Text c="dimmed">{t('changePassword.intro')}</Text>
          {error && (
            <Alert color="red" role="alert">
              {t(error)}
            </Alert>
          )}
          <PasswordInput
            label={t('changePassword.current')}
            autoComplete="current-password"
            required
            error={errors.currentPassword ? t('login.required') : undefined}
            {...register('currentPassword')}
          />
          <PasswordInput
            label={t('changePassword.new')}
            autoComplete="new-password"
            required
            error={newError}
            {...register('newPassword')}
          />
          <PasswordInput
            label={t('changePassword.confirm')}
            autoComplete="new-password"
            required
            error={errors.confirm ? t('changePassword.mismatch') : undefined}
            {...register('confirm')}
          />
          <Button type="submit" loading={isSubmitting}>
            {t('changePassword.submit')}
          </Button>
        </Stack>
      </form>
    </Paper>
  );
};
