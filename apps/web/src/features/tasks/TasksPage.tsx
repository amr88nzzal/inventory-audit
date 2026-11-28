import {
  Alert,
  Button,
  Group,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { SortableTh } from '../../components/SortableTh';
import { formatDateTime } from '../../format';
import type { PageMeta } from '../warehouses/types';
import { StatusBadge } from './StatusBadge';
import { TaskFormModal } from './TaskFormModal';
import { TASK_STATUSES } from './types';
import type { Task, TaskSearch } from './types';
import { useWarehouseOptions } from './useWarehouseOptions';

const PAGE_SIZE = 25;
const queryString = (s: TaskSearch): string => {
  const p = new URLSearchParams({
    page: String(s.page),
    pageSize: String(PAGE_SIZE),
    sort: s.sort,
    dir: s.dir,
  });
  for (const k of ['q', 'status', 'warehouseId'] as const) if (s[k]) p.set(k, s[k]);
  return p.toString();
};

export const TasksPage = ({
  search,
  onSearch,
}: {
  search: TaskSearch;
  onSearch: (next: Partial<TaskSearch>) => void;
}) => {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('inventory.task.create');
  const [creating, { open, close }] = useDisclosure();
  const warehouses = useWarehouseOptions();

  // البحث يُرسل بعد توقف الكتابة. The search is sent shortly after typing stops.
  const [term, setTerm] = useState(search.q);
  useEffect(() => setTerm(search.q), [search.q]);
  useEffect(() => {
    if (term === search.q) return;
    const id = setTimeout(() => onSearch({ q: term, page: 1 }), 300);
    return () => clearTimeout(id);
  }, [term, search.q, onSearch]);

  const list = useQuery({
    queryKey: ['tasks', search],
    queryFn: async () => {
      const r = await api.get<Task[]>(`/tasks?${queryString(search)}`);
      return { rows: r.data, meta: r.meta as unknown as PageMeta };
    },
  });
  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post('/tasks', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });

  const sortBy = (col: TaskSearch['sort']) =>
    onSearch({
      sort: col,
      dir: search.sort === col && search.dir === 'desc' ? 'asc' : 'desc',
      page: 1,
    });
  const th = (col: TaskSearch['sort'], label: string) => (
    <SortableTh
      label={label}
      active={search.sort === col}
      dir={search.dir}
      onSort={() => sortBy(col)}
    />
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1} size="h2">
          {t('tasks.title')}
        </Title>
        {canCreate && <Button onClick={open}>{t('tasks.add')}</Button>}
      </Group>

      <Group align="flex-end">
        <TextInput
          label={t('common.search')}
          description={t('tasks.searchHint')}
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
        />
        <Select
          label={t('entity.status')}
          allowDeselect={false}
          data={[
            { value: '', label: t('entity.all') },
            ...TASK_STATUSES.map((s) => ({ value: s, label: t(`tasks.status.${s}`) })),
          ]}
          value={search.status}
          onChange={(v) => onSearch({ status: (v ?? '') as TaskSearch['status'], page: 1 })}
        />
        <Select
          label={t('tasks.warehouse')}
          allowDeselect={false}
          data={[
            { value: '', label: t('entity.all') },
            ...(warehouses.data ?? []).map((w) => ({
              value: w.id,
              label: `${w.code} — ${w.name}`,
            })),
          ]}
          value={search.warehouseId}
          onChange={(v) => onSearch({ warehouseId: v ?? '', page: 1 })}
        />
      </Group>

      {list.isError && <Alert color="red">{t(errorKey(list.error))}</Alert>}
      {list.isPending ? (
        <Skeleton height={160} />
      ) : (
        list.data && (
          <>
            <Table.ScrollContainer minWidth={640}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {th('taskNo', t('tasks.no'))}
                    <Table.Th>{t('tasks.name')}</Table.Th>
                    <Table.Th>{t('tasks.warehouse')}</Table.Th>
                    <Table.Th>{t('entity.status')}</Table.Th>
                    {th('startsAt', t('tasks.startsAt'))}
                    <Table.Th>{t('tasks.assignees')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.rows.map((k) => (
                    <Table.Tr key={k.id}>
                      <Table.Td>
                        <Link to="/tasks/$id" params={{ id: k.id }}>
                          {`#${k.taskNo}`}
                        </Link>
                      </Table.Td>
                      <Table.Td>{k.title}</Table.Td>
                      <Table.Td>{k.warehouseName}</Table.Td>
                      <Table.Td>
                        <StatusBadge status={k.status} />
                      </Table.Td>
                      <Table.Td>{formatDateTime(k.startsAt, i18n.language)}</Table.Td>
                      <Table.Td>{k.assignees.length}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {list.data.rows.length === 0 && <Text c="dimmed">{t('tasks.empty')}</Text>}
            {list.data.meta.totalPages > 1 && (
              <Pagination
                total={list.data.meta.totalPages}
                value={search.page}
                onChange={(page) => onSearch({ page })}
              />
            )}
          </>
        )
      )}

      <TaskFormModal
        opened={creating}
        mode="create"
        onSubmit={async (payload) => {
          await create.mutateAsync(payload);
          close();
        }}
        onClose={close}
      />
    </Stack>
  );
};
