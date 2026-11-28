import { createTaskSchema, updateTaskSchema } from '@inventory/shared';
import {
  Alert,
  Button,
  Group,
  Modal,
  MultiSelect,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { isoToLocalInput, localInputToIso } from '../../format';
import type { Task } from './types';
import { useWarehouseOptions } from './useWarehouseOptions';

interface FormValues {
  title: string;
  warehouseId: string;
  startsAt: string;
  assigneeIds: string[];
  blindCount: boolean;
  aggregateLocations: boolean;
  tolerancePct: string;
  notes: string;
}
export const TASK_ERRORS = {
  VERSION_CONFLICT: 'tasks.versionConflict',
  TASK_NOT_EDITABLE: 'tasks.notEditable',
  INVALID_ASSIGNEE: 'tasks.invalidAssignee',
  ASSIGNEE_OUT_OF_SCOPE: 'tasks.assigneeOutOfScope',
  WAREHOUSE_INACTIVE: 'tasks.warehouseInactive',
  NO_ASSIGNEES: 'tasks.noAssignees',
  INVALID_TRANSITION: 'tasks.invalidTransition',
  NOT_FOUND: 'tasks.notFound',
  FORBIDDEN: 'common.forbidden',
};

const empty: FormValues = {
  title: '',
  warehouseId: '',
  startsAt: '',
  assigneeIds: [],
  blindCount: false,
  aggregateLocations: true,
  tolerancePct: '',
  notes: '',
};
const fromTask = (k: Task): FormValues => ({
  title: k.title,
  warehouseId: k.warehouseId,
  startsAt: isoToLocalInput(k.startsAt),
  assigneeIds: k.assignees.map((a) => a.userId),
  blindCount: k.blindCount,
  aggregateLocations: k.aggregateLocations,
  tolerancePct: k.tolerancePct ?? '',
  notes: k.notes ?? '',
});

// نبني الحمولة ثم نمرّرها على مخطط الخادم نفسه (shared). Build the payload, then run it through the server's own schema (shared).
const payloadOf = (v: FormValues, mode: 'create' | 'edit', version: number) => {
  const startsAt = localInputToIso(v.startsAt);
  const tol = v.tolerancePct.trim();
  const notes = v.notes.trim();
  const base: Record<string, unknown> = {
    title: v.title,
    assigneeIds: v.assigneeIds,
    blindCount: v.blindCount,
    aggregateLocations: v.aggregateLocations,
  };
  if (mode === 'create') {
    base['warehouseId'] = v.warehouseId;
    if (startsAt) base['startsAt'] = startsAt;
    if (tol) base['tolerancePct'] = tol;
    if (notes) base['notes'] = notes;
  } else {
    base['version'] = version;
    base['startsAt'] = startsAt;
    base['tolerancePct'] = tol === '' ? null : tol;
    base['notes'] = notes === '' ? null : notes;
  }
  return base;
};

export const TaskFormModal = ({
  opened,
  mode,
  task,
  onSubmit,
  onClose,
}: {
  opened: boolean;
  mode: 'create' | 'edit';
  task?: Task;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const warehouses = useWarehouseOptions();
  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    setValue,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty });
  const warehouseId = watch('warehouseId');
  useEffect(() => {
    if (opened) {
      reset(task ? fromTask(task) : empty);
      setError(null);
    }
  }, [opened, task, reset]);

  // من يصحّ إسناده في هذا المستودع فقط (الخادم يرفض غيرهم). Only people assignable in this warehouse (the server rejects anyone else).
  const people = useQuery({
    queryKey: ['assignable', warehouseId],
    queryFn: async () =>
      (
        await api.get<{ id: string; displayName: string }[]>(
          `/tasks/assignable-users?warehouseId=${warehouseId}`,
        )
      ).data,
    enabled: opened && warehouseId !== '',
    retry: false,
  });
  const peopleDenied = people.error instanceof ApiError && people.error.status === 403;

  const submit = handleSubmit(async (v) => {
    setError(null);
    const payload = payloadOf(v, mode, task?.version ?? 1);
    const parsed = (mode === 'create' ? createTaskSchema : updateTaskSchema).safeParse(payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const head = issue.path[0];
        if (typeof head === 'string' && head in empty)
          setFieldError(head as keyof FormValues, { message: 'invalid' });
      }
      return;
    }
    try {
      await onSubmit(payload);
    } catch (e) {
      setError(errorKey(e, TASK_ERRORS));
    }
  });

  const options = (people.data ?? []).map((p) => ({ value: p.id, label: p.displayName }));
  // المسندون الحاليون يبقون ظاهرين حتى لو خرجوا من القائمة. Current assignees stay visible even if they dropped out of the list.
  for (const a of task?.assignees ?? [])
    if (!options.some((o) => o.value === a.userId))
      options.push({ value: a.userId, label: a.displayName });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={t(mode === 'create' ? 'tasks.add' : 'tasks.edit')}
      centered
      size="lg"
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <form onSubmit={submit} noValidate>
        <Stack>
          <TextInput
            label={t('tasks.name')}
            required
            {...register('title')}
            error={errors.title ? t('tasks.titleInvalid') : undefined}
          />
          {mode === 'create' ? (
            <Controller
              control={control}
              name="warehouseId"
              render={({ field }) => (
                <Select
                  label={t('tasks.warehouse')}
                  required
                  searchable
                  data={(warehouses.data ?? []).map((w) => ({
                    value: w.id,
                    label: `${w.code} — ${w.name}`,
                  }))}
                  value={field.value || null}
                  onChange={(v) => {
                    field.onChange(v ?? '');
                    setValue('assigneeIds', []);
                  }}
                  error={errors.warehouseId ? t('tasks.warehouseRequired') : undefined}
                />
              )}
            />
          ) : (
            <Text>
              <Text span fw={600}>
                {t('tasks.warehouse')}:{' '}
              </Text>
              {task?.warehouseName}
            </Text>
          )}
          <TextInput
            type="datetime-local"
            label={t('tasks.startsAt')}
            {...register('startsAt')}
            error={errors.startsAt ? t('tasks.startsAtInvalid') : undefined}
          />
          {peopleDenied && <Alert color="orange">{t('tasks.assigneesDenied')}</Alert>}
          <Controller
            control={control}
            name="assigneeIds"
            render={({ field }) => (
              <MultiSelect
                label={t('tasks.assignees')}
                description={warehouseId ? t('tasks.assigneesHint') : t('tasks.pickWarehouseFirst')}
                searchable
                disabled={!warehouseId || peopleDenied}
                data={options}
                value={field.value}
                onChange={field.onChange}
                error={errors.assigneeIds ? t('tasks.assigneesInvalid') : undefined}
              />
            )}
          />
          <Switch
            label={t('tasks.blindCount')}
            description={t('tasks.blindCountHint')}
            checked={watch('blindCount')}
            onChange={(e) => setValue('blindCount', e.currentTarget.checked)}
          />
          <Switch
            label={t('tasks.aggregateLocations')}
            description={t('tasks.aggregateLocationsHint')}
            checked={watch('aggregateLocations')}
            onChange={(e) => setValue('aggregateLocations', e.currentTarget.checked)}
          />
          <TextInput
            label={t('tasks.tolerancePct')}
            description={t('tasks.toleranceHint')}
            {...register('tolerancePct')}
            error={errors.tolerancePct ? t('items.fieldInvalid') : undefined}
          />
          <Textarea
            label={t('tasks.notes')}
            autosize
            minRows={2}
            {...register('notes')}
            error={errors.notes ? t('tasks.notesInvalid') : undefined}
          />
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
