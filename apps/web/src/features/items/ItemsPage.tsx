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
import type { PageMeta } from '../warehouses/types';
import { ItemFormModal } from './ItemFormModal';
import type { Item, ItemSearch } from './types';

const PAGE_SIZE = 25;
const queryString = (s: ItemSearch): string => {
  const p = new URLSearchParams({
    page: String(s.page),
    pageSize: String(PAGE_SIZE),
    sort: s.sort,
    dir: s.dir,
  });
  for (const k of ['q', 'category', 'supplier', 'active'] as const) if (s[k]) p.set(k, s[k]);
  return p.toString();
};

// حقل بحث يرسل بعد توقف الكتابة. A search field that sends once typing pauses.
const DebouncedInput = ({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) => {
  const [term, setTerm] = useState(value);
  useEffect(() => setTerm(value), [value]);
  useEffect(() => {
    if (term === value) return;
    const id = setTimeout(() => onCommit(term), 300);
    return () => clearTimeout(id);
  }, [term, value, onCommit]);
  return <TextInput label={label} value={term} onChange={(e) => setTerm(e.currentTarget.value)} />;
};

export const ItemsPage = ({
  search,
  onSearch,
}: {
  search: ItemSearch;
  onSearch: (next: Partial<ItemSearch>) => void;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canCreate = usePermission('inventory.item.create');
  const canImport = usePermission('inventory.item.import');
  const [creating, { open, close }] = useDisclosure();

  const list = useQuery({
    queryKey: ['items', search],
    queryFn: async () => {
      const r = await api.get<Item[]>(`/items?${queryString(search)}`);
      return { rows: r.data, meta: r.meta as unknown as PageMeta };
    },
  });
  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post('/items', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['items'] }),
  });

  const sortBy = (col: ItemSearch['sort']) =>
    onSearch({
      sort: col,
      dir: search.sort === col && search.dir === 'asc' ? 'desc' : 'asc',
      page: 1,
    });
  const th = (col: ItemSearch['sort'], label: string) => (
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
          {t('items.title')}
        </Title>
        <Group>
          {canImport && (
            <Button component={Link} to="/items/import" variant="default">
              {t('import.open')}
            </Button>
          )}
          {canCreate && <Button onClick={open}>{t('items.add')}</Button>}
        </Group>
      </Group>

      <Group align="flex-end">
        <DebouncedInput
          label={t('common.search')}
          value={search.q}
          onCommit={(q) => onSearch({ q, page: 1 })}
        />
        <DebouncedInput
          label={t('items.category')}
          value={search.category}
          onCommit={(category) => onSearch({ category, page: 1 })}
        />
        <DebouncedInput
          label={t('items.supplier')}
          value={search.supplier}
          onCommit={(supplier) => onSearch({ supplier, page: 1 })}
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
          onChange={(v) => onSearch({ active: (v ?? '') as ItemSearch['active'], page: 1 })}
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
                    {th('barcode', t('items.barcode'))}
                    {th('name', t('items.name'))}
                    <Table.Th>{t('items.category')}</Table.Th>
                    {th('price', t('items.price'))}
                    <Table.Th>{t('items.baseUnit')}</Table.Th>
                    <Table.Th>{t('entity.status')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {list.data.rows.map((i) => (
                    <Table.Tr key={i.id}>
                      <Table.Td>
                        <Link to="/items/$id" params={{ id: i.id }}>
                          {i.barcode}
                        </Link>
                      </Table.Td>
                      <Table.Td>{i.name}</Table.Td>
                      <Table.Td>{i.category ?? '—'}</Table.Td>
                      <Table.Td>{i.price ?? '—'}</Table.Td>
                      <Table.Td>{i.baseUnit}</Table.Td>
                      <Table.Td>
                        <Badge color={i.active ? 'teal' : 'gray'} variant="light">
                          {i.active ? t('entity.activeBadge') : t('entity.inactiveBadge')}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            {list.data.rows.length === 0 && <Text c="dimmed">{t('items.empty')}</Text>}
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

      <ItemFormModal
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
