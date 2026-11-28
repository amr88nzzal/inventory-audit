import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';

// تأكيد قبل أي إجراء لا رجعة فيه مع عرض الأثر. Confirm before any irreversible action, showing its impact.
export const ConfirmDialog = ({
  opened,
  title,
  message,
  confirmLabel,
  loading,
  error,
  onConfirm,
  onClose,
}: {
  opened: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common.closeDialog') }}
      opened={opened}
      onClose={onClose}
      title={title}
      centered
    >
      <Stack>
        <Text>{message}</Text>
        {error && (
          <Text c="red.7" role="alert">
            {error}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button color="red" onClick={onConfirm} loading={loading ?? false}>
            {confirmLabel}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
