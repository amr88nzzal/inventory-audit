import { BALANCES_IMPORT_TEMPLATE } from '@inventory/shared';
import {
  Alert,
  Anchor,
  Pagination,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { CsvImportFlow } from '../../components/CsvImportFlow';
import type { PageMeta } from '../warehouses/types';
import type { Task } from './types';

export interface BalancesSearch {
  page: number;
  q: string;
}
export const parseBalancesSearch = (raw: Record<string, unknown>): BalancesSearch => {
  const page = Number(raw['page']);
  const q = raw['q'];
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    q: typeof q === 'string' || typeof q === 'number' ? String(q).slice(0, 100) : '',
  };
};

interface Balance {
  itemId: string;
  barcode: string;
  name: string;
  baseUnit: string;
  quantity: string;
}
const PAGE_SIZE = 25;

// لقطة الرصيد النظري للمهمة: الرفع للمسودة فقط، والعرض لمن يحق له (العد الأعمى يحجبه عن المسند).
// The task's theoretical balance snapshot: upload for drafts only; viewing for whoever may (blind count hides it from assignees).
export const TaskBalancesPage = ({
  id,
  search,
  onSearch,
}: {
  id: string;
  search: BalancesSearch;
  onSearch: (next: Partial<BalancesSearch>) => void;
}) => {
  const { t } = useTranslation();
  const canUpload = usePermission('inventory.task.balances');

  const task = useQuery({
    queryKey: ['task', id],
    queryFn: async () => (await api.get<Task>(`/tasks/${id}`)).data,
    retry: false,
  });
  const list = useQuery({
    queryKey: ['task-balances', id, search],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(search.page), pageSize: String(PAGE_SIZE) });
      if (search.q) p.set('q', search.q);
      const r = await api.get<Balance[]>(`/tasks/${id}/balances?${p.toString()}`);
      return { rows: r.data, meta: r.meta as unknown as PageMeta };
    },
    retry: false,
    enabled: task.isSuccess,
  });

  const [term, setTerm] = useState(search.q);
  useEffect(() => setTerm(search.q), [search.q]);
  useEffect(() => {
    if (term === search.q) return;
    const h = setTimeout(() => onSearch({ q: term, page: 1 }), 300);
    return () => clearTimeout(h);
  }, [term, search.q, onSearch]);

  const back = (
    <Link to="/tasks/$id" params={{ id }}>
      {t('tasks.backToTask')}
    </Link>
  );
  if (task.isError)
    return (
      <Stack>
        <Alert color="red">
          {t(
            task.error instanceof ApiError && task.error.status === 404
              ? 'tasks.notFound'
              : errorKey(task.error),
          )}
        </Alert>
        <Anchor component={Link} to="/tasks">
          {t('tasks.back')}
        </Anchor>
      </Stack>
    );
  if (!task.data) return <Skeleton height={160} />;
  const k = task.data;
  const blind =
    list.error instanceof ApiError &&
    list.error.status === 403 &&
    list.error.code === 'BLIND_COUNT';

  return (
    <Stack>
      {back}
      <Title order={1} size="h2">
        {`#${k.taskNo} — ${t('tasks.balances')}`}
      </Title>

      {canUpload && k.status === 'draft' && (
        <Stack>
          <Text c="dimmed">{t('balances.intro')}</Text>
          <CsvImportFlow
            endpoint={`/tasks/${id}/balances`}
            template={{ text: BALANCES_IMPORT_TEMPLATE, filename: 'task-balances-template.csv' }}
            stats={(r) => [
              ['import.stat.totalRows', r.totalRows],
              ['balances.stat.validRows', r.validRows],
              ['import.stat.skipped', r.skipped],
              ['import.stat.errorsTotal', r.errorsTotal],
            ]}
            writeCount={(r) => r.validRows}
            confirmMessage={(r, tr) =>
              tr('balances.confirmMessage', { count: r.validRows, skipped: r.skipped })
            }
            onApplied={async (qc) => {
              await qc.invalidateQueries({ queryKey: ['task-balances', id] });
              await qc.invalidateQueries({ queryKey: ['task', id] });
              await qc.invalidateQueries({ queryKey: ['tasks'] });
            }}
          />
        </Stack>
      )}
      {canUpload && k.status !== 'draft' && <Text c="dimmed">{t('balances.frozen')}</Text>}

      <Title order={2} size="h4">
        {t('balances.snapshot')}
      </Title>
      {blind && <Alert color="orange">{t('balances.blind')}</Alert>}
      {list.isError && !blind && <Alert color="red">{t(errorKey(list.error))}</Alert>}
      {!blind && (
        <>
          <TextInput
            label={t('common.search')}
            description={t('balances.searchHint')}
            value={term}
            onChange={(e) => setTerm(e.currentTarget.value)}
            maw={360}
          />
          {list.isPending ? (
            <Skeleton height={120} />
          ) : (
            list.data && (
              <>
                <Table.ScrollContainer minWidth={420}>
                  <Table striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('items.barcode')}</Table.Th>
                        <Table.Th>{t('items.name')}</Table.Th>
                        <Table.Th>{t('items.baseUnit')}</Table.Th>
                        <Table.Th>{t('balances.quantity')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {list.data.rows.map((b) => (
                        <Table.Tr key={b.itemId}>
                          <Table.Td>{b.barcode}</Table.Td>
                          <Table.Td>{b.name}</Table.Td>
                          <Table.Td>{b.baseUnit}</Table.Td>
                          <Table.Td>{b.quantity}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                {list.data.rows.length === 0 && <Text c="dimmed">{t('balances.empty')}</Text>}
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
        </>
      )}
    </Stack>
  );
};
