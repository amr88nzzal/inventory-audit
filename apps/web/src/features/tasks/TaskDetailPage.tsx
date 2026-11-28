import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  List,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatDateTime } from '../../format';
import { parseBalancesSearch } from './TaskBalancesPage';
import { parseScansSearch } from './TaskScansPage';
import { StatusBadge } from './StatusBadge';
import { TASK_ERRORS, TaskFormModal } from './TaskFormModal';
import type { Task } from './types';

export const TaskDetailPage = ({ id }: { id: string }) => {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const canUpdate = usePermission('inventory.task.update');
  const canStart = usePermission('inventory.task.start');
  const canCancel = usePermission('inventory.task.cancel');
  const [editing, editCtl] = useDisclosure();
  const [starting, startCtl] = useDisclosure();
  const [cancelling, cancelCtl] = useDisclosure();

  const q = useQuery({
    queryKey: ['task', id],
    queryFn: async () => (await api.get<Task>(`/tasks/${id}`)).data,
    retry: false,
  });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['task', id] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.patch(`/tasks/${id}`, payload),
    onSuccess: refresh,
  });
  const start = useMutation({
    mutationFn: (version: number) => api.post(`/tasks/${id}/start`, { version }),
    onSuccess: async () => {
      startCtl.close();
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: (version: number) => api.post(`/tasks/${id}/cancel`, { version }),
    onSuccess: async () => {
      cancelCtl.close();
      await refresh();
    },
  });
  // عند تعارض النسخة نُحدّث الصفحة كي يرى المستخدم الحالة الفعلية. On a version conflict we reload so the user sees the real state.
  const reloadOnConflict = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') void refresh();
  };

  if (q.isError)
    return (
      <Stack>
        <Alert color="red">
          {t(
            q.error instanceof ApiError && q.error.status === 404
              ? 'tasks.notFound'
              : errorKey(q.error),
          )}
        </Alert>
        <Anchor component={Link} to="/tasks">
          {t('tasks.back')}
        </Anchor>
      </Stack>
    );
  if (!q.data) return <Skeleton height={160} />;
  const k = q.data;
  const draft = k.status === 'draft';
  const noAssignees = k.assignees.length === 0;
  const yes = (b: boolean) => t(b ? 'common.yes' : 'common.no');
  const fields: [string, string][] = [
    [t('tasks.warehouse'), k.warehouseName],
    [t('tasks.startsAt'), formatDateTime(k.startsAt, i18n.language)],
    [t('tasks.blindCount'), yes(k.blindCount)],
    [t('tasks.aggregateLocations'), yes(k.aggregateLocations)],
    [t('tasks.tolerancePct'), k.tolerancePct ?? '—'],
    [t('tasks.balances'), t('tasks.balancesCount', { count: k.balancesCount })],
    [t('tasks.startedAt'), formatDateTime(k.startedAt, i18n.language)],
    [t('tasks.closedAt'), formatDateTime(k.closedAt, i18n.language)],
    [t('tasks.cancelledAt'), formatDateTime(k.cancelledAt, i18n.language)],
  ];

  return (
    <Stack>
      <Anchor component={Link} to="/tasks">
        {t('tasks.back')}
      </Anchor>
      <Group justify="space-between">
        <Title order={1} size="h2">
          {`#${k.taskNo} — ${k.title}`}
        </Title>
        <Group>
          {draft && canUpdate && (
            <Button variant="default" onClick={editCtl.open}>
              {t('common.edit')}
            </Button>
          )}
          {draft && canStart && (
            <Button onClick={startCtl.open} disabled={noAssignees}>
              {t('tasks.start')}
            </Button>
          )}
          {(draft || k.status === 'in_progress') && canCancel && (
            <Button color="red" variant="light" onClick={cancelCtl.open}>
              {t('tasks.cancel')}
            </Button>
          )}
        </Group>
      </Group>
      <StatusBadge status={k.status} />
      <Link to="/tasks/$id/balances" params={{ id }} search={parseBalancesSearch({})}>
        {t('tasks.balancesLink')}
      </Link>
      <Link to="/tasks/$id/scans" params={{ id }} search={parseScansSearch({})}>
        {t('tasks.scansLink')}
      </Link>
      {draft && canStart && noAssignees && <Text c="dimmed">{t('tasks.startNeedsAssignees')}</Text>}
      {k.status === 'in_progress' && <Text c="dimmed">{t('tasks.frozenNote')}</Text>}

      <Card withBorder>
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            gap: '0.5rem 1.5rem',
          }}
        >
          {fields.map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt>
                <Text c="dimmed">{label}</Text>
              </dt>
              <dd style={{ margin: 0 }}>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card withBorder>
        <Stack gap="xs">
          <Title order={2} size="h4">
            {t('tasks.assignees')}
          </Title>
          {noAssignees ? (
            <Text c="dimmed">{t('tasks.noAssigneesYet')}</Text>
          ) : (
            <List>
              {k.assignees.map((a) => (
                <List.Item key={a.userId}>{a.displayName}</List.Item>
              ))}
            </List>
          )}
        </Stack>
      </Card>
      {k.notes && (
        <Card withBorder>
          <Title order={2} size="h4">
            {t('tasks.notes')}
          </Title>
          <Text>{k.notes}</Text>
        </Card>
      )}
      {k.closingNote && (
        <Card withBorder>
          <Title order={2} size="h4">
            {t('tasks.closingNote')}
          </Title>
          <Text>{k.closingNote}</Text>
        </Card>
      )}

      <TaskFormModal
        opened={editing}
        mode="edit"
        task={k}
        onSubmit={async (payload) => {
          try {
            await save.mutateAsync(payload);
          } catch (e) {
            reloadOnConflict(e);
            throw e;
          }
          editCtl.close();
        }}
        onClose={editCtl.close}
      />
      <ConfirmDialog
        opened={starting}
        title={t('tasks.startTitle')}
        message={t('tasks.startMessage', { count: k.assignees.length })}
        confirmLabel={t('tasks.start')}
        loading={start.isPending}
        error={start.isError ? t(errorKey(start.error, TASK_ERRORS)) : null}
        onConfirm={() => start.mutate(k.version, { onError: reloadOnConflict })}
        onClose={() => {
          start.reset();
          startCtl.close();
        }}
      />
      <ConfirmDialog
        opened={cancelling}
        title={t('tasks.cancelTitle')}
        message={t(draft ? 'tasks.cancelDraftMessage' : 'tasks.cancelRunningMessage')}
        confirmLabel={t('tasks.cancel')}
        loading={cancel.isPending}
        error={cancel.isError ? t(errorKey(cancel.error, TASK_ERRORS)) : null}
        onConfirm={() => cancel.mutate(k.version, { onError: reloadOnConflict })}
        onClose={() => {
          cancel.reset();
          cancelCtl.close();
        }}
      />
    </Stack>
  );
};
