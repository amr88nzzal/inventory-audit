import { Alert, Button, Group, List, Modal, Select, Stack, Text, Textarea } from '@mantine/core';
import { recountRequestSchema } from '@inventory/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { errorKey } from '../../api/errors';

interface Outcome {
  itemId: string;
  status: 'created' | 'already_pending' | 'rejected';
  code?: string;
}
const RECOUNT_ERRORS = {
  INVALID_ASSIGNEE: 'recount.invalidAssignee',
  TASK_NOT_RUNNING: 'close.notRunning',
  NOT_FOUND: 'tasks.notFound',
  FORBIDDEN: 'common.forbidden',
};
const REJECT_CODES: Record<string, string> = {
  ITEM_NOT_IN_TASK: 'recount.rejected.ITEM_NOT_IN_TASK',
  REVIEWER_COUNTED_BEFORE: 'recount.rejected.REVIEWER_COUNTED_BEFORE',
};

// طلب إعادة عدّ لأصناف محددة أو لكل المعلَّم، لمراجع ثانٍ مسند للمهمة. النتيجة لكل صنف مستقلة.
// Request a recount for chosen items or all flagged ones, for a second reviewer assigned to the task. Each item's outcome is independent.
export const RecountModal = ({
  opened,
  taskId,
  assignees,
  items,
  tolerancePct,
  onClose,
}: {
  opened: boolean;
  taskId: string;
  assignees: { userId: string; displayName: string }[];
  // null = كل المعلَّم؛ وإلا الأصناف المختارة (معرّف واسم). null = all flagged; otherwise the chosen items (id and name).
  items: { id: string; name: string }[] | null;
  tolerancePct: string;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reviewer, setReviewer] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);

  useEffect(() => {
    if (opened) {
      setReviewer(null);
      setReason('');
      setError(null);
      setOutcomes(null);
    }
  }, [opened]);

  const send = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post<Outcome[]>(`/tasks/${taskId}/recounts`, payload),
  });

  const submit = async () => {
    setError(null);
    const payload: Record<string, unknown> = { assigneeId: reviewer, tolerancePct };
    if (items) payload['itemIds'] = items.map((i) => i.id);
    else payload['flagged'] = true;
    if (reason.trim()) payload['reason'] = reason.trim();
    if (!recountRequestSchema.safeParse(payload).success) {
      setError('recount.invalid');
      return;
    }
    try {
      const r = await send.mutateAsync(payload);
      setOutcomes(r.data);
      await qc.invalidateQueries({ queryKey: ['task-results', taskId] });
    } catch (e) {
      setError(errorKey(e, RECOUNT_ERRORS));
    }
  };

  const names = new Map((items ?? []).map((i) => [i.id, i.name]));
  const count = (s: Outcome['status']) => (outcomes ?? []).filter((o) => o.status === s).length;

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common.closeDialog') }}
      opened={opened}
      onClose={onClose}
      title={t('recount.title')}
      centered
    >
      <Stack>
        {outcomes ? (
          <>
            <Alert color={count('created') > 0 ? 'green' : 'orange'}>
              {t('recount.summary', {
                created: count('created'),
                pending: count('already_pending'),
                rejected: count('rejected'),
              })}
            </Alert>
            {count('rejected') > 0 && (
              <List>
                {outcomes
                  .filter((o) => o.status === 'rejected')
                  .map((o) => (
                    <List.Item key={o.itemId}>
                      {`${names.get(o.itemId) ?? o.itemId}: ${t(
                        REJECT_CODES[o.code ?? ''] ?? 'common.genericError',
                      )}`}
                    </List.Item>
                  ))}
              </List>
            )}
            <Group justify="flex-end">
              <Button onClick={onClose}>{t('recount.done')}</Button>
            </Group>
          </>
        ) : (
          <>
            <Text>
              {items ? t('recount.scopeItems', { count: items.length }) : t('recount.scopeFlagged')}
            </Text>
            <Text c="dimmed" size="sm">
              {t('recount.hint')}
            </Text>
            <Select
              label={t('recount.reviewer')}
              data={assignees.map((a) => ({ value: a.userId, label: a.displayName }))}
              value={reviewer}
              onChange={setReviewer}
              nothingFoundMessage={t('recount.noReviewers')}
            />
            <Textarea
              label={t('recount.reason')}
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              maxLength={300}
              autosize
              minRows={2}
            />
            {error && (
              <Text c="red.7" role="alert">
                {t(error)}
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void submit()} loading={send.isPending} disabled={!reviewer}>
                {t('recount.submit')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
};
