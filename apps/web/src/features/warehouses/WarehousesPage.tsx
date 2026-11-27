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
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { EntityFormModal } from './EntityFormModal';
import type { Warehouse, PageMeta, WarehouseSearch } from './types';

const PAGE_SIZE = 25;
export const WAREHOUSE_ERRORS = {
  WAREHOUSE_CODE_TAKEN: 'warehouses.codeTaken',
  SCOPE_RESTRICTED: 'warehouses.scopeRestricted',
  VERSION_CONFLICT: 'warehouses.versionConflict',
  FORBIDDEN: 'common.forbidden',
};

const queryString = (s: WarehouseSearch): string => {
  const p = new URLSearchParams({
    page: String(s.page),
    pageSize: String(PAGE_SIZE),
    sort: s.sort,
    dir: s.dir,
  });
  if (s.q) p.set('q', s.q);
  if (s.active) p.set('active', s.active);
  return p.toString();
};

// القائمة بترقيم وفرز وبحث وفلترة من الخادم، وحالتها في الـ URL.
// The list pages, sorts, searches and filters on the server, and its state lives in the URL.
export const WarehousesPage = ({
  search,
  onSearch,
}: {
  search: WarehouseSearch;
  onSearch: (next: Partial<WarehouseSearch>) => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('inventory.warehouse.create');
  const [creating, { open, close }] = useDisclosure();

  // البحث يُرسل بعد توقف الكتابة قليلاً. The search is sent shortly after typing stops.
  const [term, setTerm] = useState(search.q);
  useEffect(() => setTerm(search.q), [search.q]);
  useEffect(() => {
    if (term === search.q) return;
    const id = setTimeout(() => onSearch({ q: term, page: 1 }), 300);
    return () => clearTimeout(id);
  }, [term, search.q, onSearch]);

  const list = useQuery({
    queryKey: ['warehouses', search],
    queryFn: async () => {
      const r = await api.get<Warehouse[]>(`/warehouses?${queryString(search)}`);
      return { rows: r.data, meta: r.meta as unknown as PageMeta };
    },
  });

  const create = useMutation({
    mutationFn: (v: { code: string; name: string }) => api.post('/warehouses', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
  });

  const sortBy = (col: WarehouseSearch['sort']) =>
    onSearch({
      sort: col,
      dir: search.sort === col && search.dir === 'asc' ? 'desc' : 'asc',
      page: 1,
    });
  const header = (col: WarehouseSearch['sort'], label: string) => (
    <Table.Th
      aria-sort={search.sort === col ? (search.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <UnstyledButton onClick={() => sortBy(col)} fw={600}>
        {label}
        {search.sort === col ? (search.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </UnstyledButton>
    </Table.Th>
  );

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={1} size="h2">
          {t('warehouses.title')}
        </Title>
        {canCreate && <Button onClick={open}>{t('warehouses.add')}</Button>}
      </Group>

      <Group align="flex-end">
        <TextInput
          label={t('common.search')}
          value={term}
          onChange={(e) => setTerm(e.currentTarget.value)}
        />
        <Select
          label={t('entity.status')}
          allowDeselect={false}
          data={[
            { value: '', label: t('entity.all') },
            { value: 'true', label: t('entity.activeOnly') },
            { value: 'false', label: t('entity.inactiveOnly') },
          ]}
          value={search.active}
          onChange={(v) => onSearch({ active: (v ?? '') as WarehouseSearch['active'], page: 1 })}
        />
      </Group>

      {list.isError && <Alert color="red">{t(errorKey(list.error))}</Alert>}
      {list.isPending ? (
        <Skeleton height={160} />
      ) : (
        list.data && (
          <>
            <Table.ScrollContainer minWidth={420}>
              <Table striped highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {header('code', t('entity.code'))}
                    {header('name', t('entity.name'))}
                    <Table.Th>{t('entity.status')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.rows.map((w) => (
                    <Table.Tr key={w.id}>
                      <Table.Td>
                        <Link to="/warehouses/$id" params={{ id: w.id }}>
                          {w.code}
                        </Link>
                      </Table.Td>
                      <Table.Td>{w.name}</Table.Td>
                      <Table.Td>
                        <Badge color={w.active ? 'teal' : 'gray'} variant="light">
                          {w.active ? t('entity.activeBadge') : t('entity.inactiveBadge')}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {list.data.rows.length === 0 && <Text c="dimmed">{t('warehouses.empty')}</Text>}
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

      <EntityFormModal
        opened={creating}
        mode="create"
        title={t('warehouses.add')}
        errorMap={WAREHOUSE_ERRORS}
        onSubmit={async (v) => {
          await create.mutateAsync({ code: v.code, name: v.name });
          close();
        }}
        onClose={close}
      />
    </Stack>
  );
};
