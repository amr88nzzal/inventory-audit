import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Pagination,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { RESULT_FILTERS, RESULT_SORTS } from '@inventory/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDisclosure } from '@mantine/hooks';
import { usePermission } from '../../auth/AuthProvider';
import { CloseTaskModal } from './CloseTaskModal';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import type { PageMeta } from '../warehouses/types';
import type { Task } from './types';

type Filter = (typeof RESULT_FILTERS)[number];
type Sort = (typeof RESULT_SORTS)[number];
export interface ResultsSearch {
  page: number;
  filter: Filter;
  sort: Sort;
  q: string;
  tolerancePct: string;
}
const DECIMAL = /^\d{1,6}(\.\d{1,4})?$/;
const str = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';
export const parseResultsSearch = (raw: Record<string, unknown>): ResultsSearch => {
  const page = Number(raw['page']);
  const filter = str(raw['filter']);
  const sort = str(raw['sort']);
  const tol = str(raw['tolerancePct']);
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    filter: (RESULT_FILTERS as readonly string[]).includes(filter) ? (filter as Filter) : 'all',
    sort: (RESULT_SORTS as readonly string[]).includes(sort) ? (sort as Sort) : 'difference',
    q: str(raw['q']).slice(0, 100),
    tolerancePct: DECIMAL.test(tol) ? tol : '0',
  };
};

interface Row {
  itemId: string;
  barcode: string;
  name: string;
  baseUnit: string;
  theoretical: string;
  counted: string;
  difference: string;
  differencePct: string | null;
  status: 'match' | 'over' | 'short';
  flaggedForRecount: boolean;
  recountPending: boolean;
  round: number;
}
interface Summary {
  items: number;
  matched: number;
  over: number;
  short: number;
  flagged: number;
  totalCounted: string;
  totalTheoretical: string;
  totalDifference: string;
  unknownBarcodes: number;
  unknownQuantity: string;
  recountPending: number;
}
interface Unknown {
  barcode: string;
  quantity: string;
  records: number;
}
const PAGE_SIZE = 25;
// ألوان الحالات من Mantine: مطابق أخضر، زيادة برتقالي، نقص أحمر. Status colours from Mantine: match green, over orange, short red.
const STATUS_COLOR = { match: 'green', over: 'orange', short: 'red' } as const;

// نتائج الجرد: للمشرف فقط (تكشف الرصيد النظري). بعد الإغلاق تُقرأ من النسخة المجمّدة.
// Count results: supervisor only (they reveal the theoretical balance). After close they are read from the frozen copy.
export const TaskResultsPage = ({
  id,
  search,
  onSearch,
}: {
  id: string;
  search: ResultsSearch;
  onSearch: (next: Partial<ResultsSearch>) => void;
}) => {
  const { t } = useTranslation();
  const canClose = usePermission('inventory.task.close');
  const [closing, closeCtl] = useDisclosure();
  const task = useQuery({
    queryKey: ['task', id],
    queryFn: async () => (await api.get<Task>(`/tasks/${id}`)).data,
    retry: false,
  });
  const res = useQuery({
    queryKey: ['task-results', id, search],
    queryFn: async () => {
      const p = new URLSearchParams({
        page: String(search.page),
        pageSize: String(PAGE_SIZE),
        filter: search.filter,
        sort: search.sort,
        tolerancePct: search.tolerancePct,
      });
      if (search.q) p.set('q', search.q);
      const r = await api.get<Row[]>(`/tasks/${id}/results?${p.toString()}`);
      const meta = r.meta as unknown as PageMeta & { frozen: boolean; summary: Summary };
      return { rows: r.data, meta };
    },
    enabled: task.isSuccess,
    retry: false,
  });
  const unknown = useQuery({
    queryKey: ['task-unknown', id],
    queryFn: async () =>
      (await api.get<Unknown[]>(`/tasks/${id}/results/unknown?page=1&pageSize=${PAGE_SIZE}`)).data,
    enabled: res.isSuccess,
  });

  const [term, setTerm] = useState(search.q);
  useEffect(() => setTerm(search.q), [search.q]);
  useEffect(() => {
    if (term === search.q) return;
    const h = setTimeout(() => onSearch({ q: term, page: 1 }), 300);
    return () => clearTimeout(h);
  }, [term, search.q, onSearch]);
  const [tol, setTol] = useState(search.tolerancePct);
  useEffect(() => setTol(search.tolerancePct), [search.tolerancePct]);
  const tolValid = DECIMAL.test(tol);
  useEffect(() => {
    if (tol === search.tolerancePct || !tolValid) return;
    const h = setTimeout(() => onSearch({ tolerancePct: tol, page: 1 }), 400);
    return () => clearTimeout(h);
  }, [tol, tolValid, search.tolerancePct, onSearch]);

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
      </Stack>
    );
  if (!task.data) return <Skeleton height={160} />;
  const k = task.data;
  const meta = res.data?.meta;
  const s = meta?.summary;
  const frozen = meta?.frozen ?? false;

  const card = (label: string, value: string | number, color?: string) => (
    <Card withBorder padding="sm" key={label}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl" {...(color ? { c: color } : {})}>
        {value}
      </Text>
    </Card>
  );

  return (
    <Stack>
      {back}
      <Group justify="space-between">
        <Title order={1} size="h2">
          {`#${k.taskNo} — ${t('results.title')}`}
        </Title>
        {canClose && k.status === 'in_progress' && s && (
          <Button color="red" variant="light" onClick={closeCtl.open}>
            {t('close.open')}
          </Button>
        )}
      </Group>
      {s && canClose && k.status === 'in_progress' && (
        <CloseTaskModal
          opened={closing}
          taskId={id}
          version={k.version}
          flagged={s.flagged}
          recountPending={s.recountPending}
          onClose={closeCtl.close}
        />
      )}
      {res.isError && <Alert color="red">{t(errorKey(res.error))}</Alert>}
      {res.isPending && !res.isError && <Skeleton height={200} />}

      {s && (
        <>
          <Alert color={frozen ? 'teal' : 'blue'}>
            {t(frozen ? 'results.frozen' : 'results.live')}
          </Alert>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            {card(t('results.items'), s.items)}
            {card(t('results.matched'), s.matched, 'green.8')}
            {card(t('results.over'), s.over, 'orange.8')}
            {card(t('results.short'), s.short, 'red.8')}
            {card(t('results.flagged'), s.flagged)}
            {card(t('results.recountPending'), s.recountPending)}
            {card(t('results.totalTheoretical'), s.totalTheoretical)}
            {card(t('results.totalCounted'), s.totalCounted)}
            {card(t('results.totalDifference'), s.totalDifference)}
            {card(
              t('results.unknownBarcodes'),
              s.unknownBarcodes,
              s.unknownBarcodes > 0 ? 'orange.8' : undefined,
            )}
          </SimpleGrid>

          <Group align="flex-end">
            <TextInput
              label={t('common.search')}
              description={t('balances.searchHint')}
              value={term}
              onChange={(e) => setTerm(e.currentTarget.value)}
            />
            <Select
              label={t('results.filter')}
              allowDeselect={false}
              data={RESULT_FILTERS.map((f) => ({ value: f, label: t(`results.filters.${f}`) }))}
              value={search.filter}
              onChange={(v) => onSearch({ filter: (v ?? 'all') as Filter, page: 1 })}
            />
            <Select
              label={t('results.sort')}
              allowDeselect={false}
              data={RESULT_SORTS.map((x) => ({ value: x, label: t(`results.sorts.${x}`) }))}
              value={search.sort}
              onChange={(v) => onSearch({ sort: (v ?? 'difference') as Sort, page: 1 })}
            />
            {!frozen && (
              <TextInput
                label={t('results.tolerance')}
                description={t('results.toleranceHint')}
                value={tol}
                onChange={(e) => setTol(e.currentTarget.value)}
                error={tolValid ? undefined : t('items.fieldInvalid')}
                w={160}
              />
            )}
          </Group>

          <Table.ScrollContainer minWidth={760}>
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('items.barcode')}</Table.Th>
                  <Table.Th>{t('items.name')}</Table.Th>
                  <Table.Th>{t('items.baseUnit')}</Table.Th>
                  <Table.Th>{t('results.theoretical')}</Table.Th>
                  <Table.Th>{t('results.counted')}</Table.Th>
                  <Table.Th>{t('results.difference')}</Table.Th>
                  <Table.Th>{t('results.pct')}</Table.Th>
                  <Table.Th>{t('entity.status')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(res.data?.rows ?? []).map((r) => (
                  <Table.Tr key={r.itemId}>
                    <Table.Td>{r.barcode}</Table.Td>
                    <Table.Td>{r.name}</Table.Td>
                    <Table.Td>{r.baseUnit}</Table.Td>
                    <Table.Td>{r.theoretical}</Table.Td>
                    <Table.Td>{r.counted}</Table.Td>
                    <Table.Td>{r.difference}</Table.Td>
                    <Table.Td>{r.differencePct === null ? '—' : `${r.differencePct}%`}</Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge color={STATUS_COLOR[r.status]} variant="light">
                          {t(`results.status.${r.status}`)}
                        </Badge>
                        {r.flaggedForRecount && (
                          <Badge color="orange" variant="outline">
                            {t('results.needsRecount')}
                          </Badge>
                        )}
                        {r.recountPending && (
                          <Badge color="gray" variant="outline">
                            {t('results.recountWaiting')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
          {res.data?.rows.length === 0 && <Text c="dimmed">{t('results.empty')}</Text>}
          {meta && meta.totalPages > 1 && (
            <Pagination
              total={meta.totalPages}
              value={search.page}
              onChange={(page) => onSearch({ page })}
            />
          )}

          {s.unknownBarcodes > 0 && (
            <Card withBorder>
              <Stack gap="xs">
                <Title order={2} size="h4">
                  {t('results.unknownTitle')}
                </Title>
                <Text c="dimmed">{t('results.unknownHint')}</Text>
                <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('items.barcode')}</Table.Th>
                      <Table.Th>{t('balances.quantity')}</Table.Th>
                      <Table.Th>{t('results.records')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {(unknown.data ?? []).map((u) => (
                      <Table.Tr key={u.barcode}>
                        <Table.Td>{u.barcode}</Table.Td>
                        <Table.Td>{u.quantity}</Table.Td>
                        <Table.Td>{u.records}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {s.unknownBarcodes > PAGE_SIZE && (
                  <Text c="dimmed" size="sm">
                    {t('results.unknownTruncated', { shown: PAGE_SIZE, total: s.unknownBarcodes })}
                  </Text>
                )}
              </Stack>
            </Card>
          )}
        </>
      )}
    </Stack>
  );
};
