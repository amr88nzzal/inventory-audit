import { Badge } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { TaskStatus } from './types';

// ألوان الحالات من ألوان Mantine فقط. Status colours come from Mantine colours only.
const COLORS: Record<TaskStatus, string> = {
  draft: 'gray',
  in_progress: 'blue',
  closed: 'green',
  cancelled: 'red',
};
export const StatusBadge = ({ status }: { status: TaskStatus }) => {
  const { t } = useTranslation();
  return (
    <Badge color={COLORS[status]} variant="light">
      {t(`tasks.status.${status}`)}
    </Badge>
  );
};
