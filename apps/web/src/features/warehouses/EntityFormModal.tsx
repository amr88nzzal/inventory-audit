import { zodResolver } from '@hookform/resolvers/zod';
import { Button, Group, Modal, Stack, Switch, TextInput } from '@mantine/core';
import { CODE_PATTERN } from '@inventory/shared';
import { z } from 'zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { errorKey } from '../../api/errors';

export interface EntityValues {
  code: string;
  name: string;
  active: boolean;
}

// القواعد نفسها في الخادم (CODE_PATTERN والاسم 1-120). The same rules as the server (CODE_PATTERN, name 1-120).
const nameField = z.string().trim().min(1).max(120);
const createSchema = z.object({
  code: z.string().trim().regex(CODE_PATTERN),
  name: nameField,
  active: z.boolean(),
});
const editSchema = z.object({ code: z.string(), name: nameField, active: z.boolean() });

// نموذج واحد للمستودع والموقع (لهما الحقول نفسها): الرمز عند الإنشاء فقط، والتفعيل عند التعديل فقط.
// One form for warehouse and location (same fields): the code on create only, the active switch on edit only.
export const EntityFormModal = ({
  opened,
  mode,
  initial,
  title,
  errorMap,
  onSubmit,
  onClose,
}: {
  opened: boolean;
  mode: 'create' | 'edit';
  initial?: { code: string; name: string; active: boolean };
  title: string;
  errorMap: Record<string, string>;
  onSubmit: (v: EntityValues) => Promise<void>;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<EntityValues>({
    resolver: zodResolver(mode === 'create' ? createSchema : editSchema),
    defaultValues: { code: '', name: '', active: true },
  });
  useEffect(() => {
    if (opened) {
      reset({
        code: initial?.code ?? '',
        name: initial?.name ?? '',
        active: initial?.active ?? true,
      });
      setError(null);
    }
  }, [opened, initial, reset]);

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await onSubmit(v);
    } catch (e) {
      setError(errorKey(e, errorMap));
    }
  });

  return (
    <Modal opened={opened} onClose={onClose} title={title} centered>
      <form onSubmit={submit} noValidate>
        <Stack>
          {mode === 'create' && (
            <TextInput
              label={t('entity.code')}
              description={t('entity.codeHint')}
              required
              {...register('code')}
              error={errors.code ? t('entity.codeInvalid') : undefined}
            />
          )}
          <TextInput
            label={t('entity.name')}
            required
            {...register('name')}
            error={errors.name ? t('entity.nameRequired') : undefined}
          />
          {mode === 'edit' && (
            <Switch
              label={t('entity.active')}
              checked={watch('active')}
              onChange={(e) => setValue('active', e.currentTarget.checked)}
            />
          )}
          {error && (
            <div role="alert" style={{ color: 'var(--mantine-color-red-7)' }}>
              {t(error)}
            </div>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
