import {
  Alert,
  Badge,
  Button,
  Group,
  Pagination,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { useAuth, usePermission } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { formatDateTime } from '../../format';
import type { PageMeta } from '../warehouses/types';
import { parseTaskSearch } from './types';
import type { Task } from './types';

export interface ScansSearch {
  page: number;
  kind: '' | 'count' | 'void';
  userId: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const parseScansSearch = (raw: Record<string, unknown>): ScansSearch => {
  const page = Number(raw['page']);
  const kind = raw['kind'];
  const user = typeof raw['userId'] === 'string' ? raw['userId'] : '';
  return {
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    kind: kind === 'count' || kind === 'void' ? kind : '',
    userId: UUID.test(user) ? user : '',
  };
};

interface Scan {
  id: string;
  kind: 'count' | 'void';
  userId: string;
  userName: string;
  barcode: string | null;
  itemId: string | null;
  itemName: string | null;
  quantity: string | null;
  unitName: string | null;
  baseQuantity: string | null;
  locationCode: string | null;
  voidsId: string | null;
  voided: boolean;
  note: string | null;
  scannedAt: string;
}
interface ScanResult {
  id: string;
  status: 'created' | 'duplicate' | 'rejected';
  code?: string;
}
const PAGE_SIZE = 25;
// رفض الإلغاء بحسب رمز الخادم. A void refusal by the server's code.
const VOID_ERRORS: Record<string, string> = {
  VOID_TARGET_NOT_FOUND: 'scans.errNotFound',
  VOID_TARGET_INVALID: 'scans.errInvalid',
  ALREADY_VOIDED: 'scans.errAlreadyVoided',
  RECOUNT_RESTRICTED: 'scans.errRecount',
  TASK_NOT_RUNNING: 'scans.errNotRunning',
  NOT_ASSIGNED: 'scans.errNotAssigned',
};

// سجل المسح للمهمة. الإبطال لعدّ المستخدم نفسه فقط (الخادم يفرض ذلك) والمهمة جارية.
// The task's scan log. Voiding is only for the user's own counts (the server enforces it) while the task runs.
export const TaskScansPage = ({
  id,
  search,
  onSearch,
}: {
  id: string;
  search: ScansSearch;
  onSearch: (next: Partial<ScansSearch>) => void;
}) => {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { state } = useAuth();
  const me = state.status === 'authed' ? state.user.id : '';
  const canScan = usePermission('inventory.task.scan');
  const seeAll = usePermission('inventory.task.read_all');
  const [target, setTarget] = useState<Scan | null>(null);
  const [voidError, setVoidError] = useState<string | null>(null);

  const task = useQuery({
    queryKey: ['task', id],
    queryFn: async () => (await api.get<Task>(`/tasks/${id}`)).data,
    retry: false,
  });
  const list = useQuery({
    queryKey: ['task-scans', id, search],
    queryFn: async () => {
      const p = new URLSearchParams({ page: String(search.page), pageSize: String(PAGE_SIZE) });
      if (search.kind) p.set('kind', search.kind);
      if (search.userId && seeAll) p.set('userId', search.userId);
      const r = await api.get<Scan[]>(`/tasks/${id}/scans?${p.toString()}`);
      return { rows: r.data, meta: r.meta as unknown as PageMeta };
    },
    enabled: task.isSuccess,
  });

  const voidScan = useMutation({
    mutationFn: async (s: Scan) => {
      const r = await api.post<ScanResult[]>(`/tasks/${id}/scans`, {
        events: [
          {
            id: crypto.randomUUID(),
            kind: 'void',
            voidsId: s.id,
            scannedAt: new Date().toISOString(),
          },
        ],
      });
      const res = r.data[0];
      // الرفض يأتي نجاحاً بحالة rejected في الحمولة. A refusal arrives as a success with status rejected in the payload.
      if (!res || res.status === 'rejected')
        throw new Error(VOID_ERRORS[res?.code ?? ''] ?? 'scans.errGeneric');
      return res;
    },
    onSuccess: async () => {
      setTarget(null);
      await qc.invalidateQueries({ queryKey: ['task-scans', id] });
    },
    onError: (e) => {
      if (e instanceof ApiError)
        setVoidError(errorKey(e, { TASK_NOT_RUNNING: 'scans.errNotRunning' }));
      else setVoidError(e instanceof Error ? e.message : 'scans.errGeneric');
    },
  });

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
        <Link to="/tasks" search={parseTaskSearch({})}>
          {t('tasks.back')}
        </Link>
      </Stack>
    );
  if (!task.data) return <Skeleton height={160} />;
  const k = task.data;
  const running = k.status === 'in_progress';

  return (
    <Stack>
      <Link to="/tasks/$id" params={{ id }}>
        {t('tasks.backToTask')}
      </Link>
      <Title order={1} size="h2">
        {`#${k.taskNo} — ${t('scans.title')}`}
      </Title>
      {!seeAll && <Text c="dimmed">{t('scans.ownOnly')}</Text>}

      <Group align="flex-end">
        <Select
          label={t('scans.kind')}
          allowDeselect={false}
          data={[
            { value: '', label: t('entity.all') },
            { value: 'count', label: t('scans.kindCount') },
            { value: 'void', label: t('scans.kindVoid') },
          ]}
          value={search.kind}
          onChange={(v) => onSearch({ kind: (v ?? '') as ScansSearch['kind'], page: 1 })}
        />
        {seeAll && (
          <Select
            label={t('scans.user')}
            allowDeselect={false}
            data={[
              { value: '', label: t('entity.all') },
              ...k.assignees.map((a) => ({ value: a.userId, label: a.displayName })),
            ]}
            value={search.userId}
            onChange={(v) => onSearch({ userId: v ?? '', page: 1 })}
          />
        )}
      </Group>

      {list.isError && <Alert color="red">{t(errorKey(list.error))}</Alert>}
      {list.isPending ? (
        <Skeleton height={160} />
      ) : (
        list.data && (
          <>
            <Table.ScrollContainer minWidth={720}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('scans.time')}</Table.Th>
                    <Table.Th>{t('scans.user')}</Table.Th>
                    <Table.Th>{t('items.barcode')}</Table.Th>
                    <Table.Th>{t('scans.item')}</Table.Th>
                    <Table.Th>{t('balances.quantity')}</Table.Th>
                    <Table.Th>{t('scans.location')}</Table.Th>
                    <Table.Th>{t('entity.status')}</Table.Th>
                    {canScan && <Table.Th>{t('common.actions')}</Table.Th>}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.rows.map((s) => (
                    <Table.Tr key={s.id}>
                      <Table.Td>{formatDateTime(s.scannedAt, i18n.language)}</Table.Td>
                      <Table.Td>{s.userName}</Table.Td>
                      <Table.Td>{s.barcode ?? '—'}</Table.Td>
                      <Table.Td>
                        {s.kind === 'void' ? (
                          '—'
                        ) : s.itemName ? (
                          s.itemName
                        ) : (
                          <Badge color="orange" variant="light">
                            {t('scans.unknownItem')}
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {s.quantity === null
                          ? '—'
                          : `${s.quantity}${s.unitName ? ` ${s.unitName}` : ''}`}
                      </Table.Td>
                      <Table.Td>{s.locationCode ?? '—'}</Table.Td>
                      <Table.Td>
                        {s.kind === 'void' ? (
                          <Badge color="gray" variant="light">
                            {t('scans.kindVoid')}
                          </Badge>
                        ) : s.voided ? (
                          <Badge color="red" variant="light">
                            {t('scans.voided')}
                          </Badge>
                        ) : (
                          <Badge color="green" variant="light">
                            {t('scans.kindCount')}
                          </Badge>
                        )}
                      </Table.Td>
                      {canScan && (
                        <Table.Td>
                          {running && s.kind === 'count' && !s.voided && s.userId === me && (
                            <Button
                              size="compact-sm"
                              color="red"
                              variant="light"
                              aria-label={`${t('scans.void')} ${s.barcode ?? ''}`}
                              onClick={() => {
                                setVoidError(null);
                                setTarget(s);
                              }}
                            >
                              {t('scans.void')}
                            </Button>
                          )}
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {list.data.rows.length === 0 && <Text c="dimmed">{t('scans.empty')}</Text>}
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

      <ConfirmDialog
        opened={target !== null}
        title={t('scans.voidTitle')}
        message={t('scans.voidMessage', {
          barcode: target?.barcode ?? '',
          quantity: target?.quantity ?? '',
        })}
        confirmLabel={t('scans.void')}
        loading={voidScan.isPending}
        error={voidError ? t(voidError) : null}
        onConfirm={() => target && voidScan.mutate(target)}
        onClose={() => {
          setTarget(null);
          setVoidError(null);
        }}
      />
    </Stack>
  );
};
