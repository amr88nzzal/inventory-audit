import { Alert, Button, Checkbox, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { closeTaskSchema } from '@inventory/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';

const CLOSE_ERRORS = {
  UNRESOLVED_VARIANCES: 'close.unresolved',
  RECOUNT_PENDING: 'close.recountPending',
  VERSION_CONFLICT: 'tasks.versionConflict',
  INVALID_TRANSITION: 'tasks.invalidTransition',
  TASK_NOT_RUNNING: 'close.notRunning',
  IDEMPOTENCY_KEY_REUSED: 'close.keyReused',
  NOT_FOUND: 'tasks.notFound',
  FORBIDDEN: 'common.forbidden',
};

// إغلاق المهمة: لا رجعة فيه. مفتاح عدم التكرار يتغيّر مع تغيّر الطلب ويبقى عند انقطاع الشبكة فقط.
// Closing is irreversible. The idempotency key changes with the request and is kept only across network drops.
export const CloseTaskModal = ({
  opened,
  taskId,
  version,
  flagged,
  recountPending,
  onClose,
}: {
  opened: boolean;
  taskId: string;
  version: number;
  flagged: number;
  recountPending: number;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  useEffect(() => {
    if (opened) {
      setNote('');
      setAck(false);
      setError(null);
      key.current = null;
    }
  }, [opened]);

  const close = useMutation({
    mutationFn: (payload: Record<string, unknown>) => {
      key.current ??= crypto.randomUUID();
      return api.post(`/tasks/${taskId}/close`, payload, {
        headers: { 'Idempotency-Key': key.current },
      });
    },
  });

  const blocked = recountPending > 0;
  const needsAck = flagged > 0;
  const submit = async () => {
    setError(null);
    const payload: Record<string, unknown> = { version, acknowledgeFlagged: ack };
    if (note.trim()) payload['note'] = note.trim();
    if (!closeTaskSchema.safeParse(payload).success) {
      setError('close.noteInvalid');
      return;
    }
    try {
      await close.mutateAsync(payload);
    } catch (e) {
      // الطلب تغيّر أو فشل منطقياً: مفتاح جديد في المحاولة التالية. A changed or logically failed request gets a new key next time.
      if (!(e instanceof ApiError && e.status === 0)) key.current = null;
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        await qc.invalidateQueries({ queryKey: ['task', taskId] });
      }
      setError(errorKey(e, CLOSE_ERRORS));
      return;
    }
    await qc.invalidateQueries({ queryKey: ['task', taskId] });
    await qc.invalidateQueries({ queryKey: ['task-results', taskId] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
    onClose();
  };

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common.closeDialog') }}
      opened={opened}
      onClose={onClose}
      title={t('close.title')}
      centered
    >
      <Stack>
        <Text>{t('close.impact')}</Text>
        {blocked && (
          <Alert color="red">{t('close.blockedByRecount', { count: recountPending })}</Alert>
        )}
        {needsAck && !blocked && (
          <Alert color="orange">{t('close.flaggedWarning', { count: flagged })}</Alert>
        )}
        {needsAck && (
          <Checkbox
            label={t('close.acknowledge')}
            checked={ack}
            onChange={(e) => {
              setAck(e.currentTarget.checked);
              key.current = null;
            }}
          />
        )}
        <Textarea
          label={t('close.note')}
          value={note}
          onChange={(e) => {
            setNote(e.currentTarget.value);
            key.current = null;
          }}
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
          <Button
            color="red"
            onClick={() => void submit()}
            loading={close.isPending}
            disabled={blocked || (needsAck && !ack)}
          >
            {t('close.confirm')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
