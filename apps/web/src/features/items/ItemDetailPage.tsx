import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ItemFormModal } from './ItemFormModal';
import { parseItemSearch } from './types';
import type { Item } from './types';

export const ItemDetailPage = ({ id }: { id: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canUpdate = usePermission('inventory.item.update');
  const canDelete = usePermission('inventory.item.delete');
  const [editing, editCtl] = useDisclosure();
  const [deleting, delCtl] = useDisclosure();
  const [delError, setDelError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['item', id],
    queryFn: async () => (await api.get<Item>(`/items/${id}`)).data,
    retry: false,
  });
  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.patch(`/items/${id}`, payload),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['item', id] });
      await qc.invalidateQueries({ queryKey: ['items'] });
    },
  });
  const remove = useMutation({ mutationFn: () => api.del(`/items/${id}`) });

  if (q.isError)
    return (
      <Stack>
        <Alert color="red">
          {t(
            q.error instanceof ApiError && q.error.status === 404
              ? 'items.notFound'
              : errorKey(q.error),
          )}
        </Alert>
        <Anchor component={Link} to="/items">
          {t('items.back')}
        </Anchor>
      </Stack>
    );
  if (!q.data) return <Skeleton height={160} />;
  const i = q.data;
  const dash = (v: string | null) => v ?? '—';
  const fields: [string, string][] = [
    [t('items.barcode'), i.barcode],
    [t('items.sku'), dash(i.sku)],
    [t('items.category'), dash(i.category)],
    [t('items.supplier'), dash(i.supplier)],
    [t('items.accountNo'), dash(i.accountNo)],
    [t('items.price'), dash(i.price)],
    [t('items.tolerancePct'), dash(i.tolerancePct)],
    [t('items.baseUnit'), i.baseUnit],
  ];

  return (
    <Stack>
      <Anchor component={Link} to="/items">
        {t('items.back')}
      </Anchor>
      <Group justify="space-between">
        <Title order={1} size="h2">
          {i.name}
        </Title>
        <Group>
          {canUpdate && (
            <Button variant="default" onClick={editCtl.open}>
              {t('common.edit')}
            </Button>
          )}
          {canDelete && (
            <Button color="red" variant="light" onClick={delCtl.open}>
              {t('common.delete')}
            </Button>
          )}
        </Group>
      </Group>
      <Badge w="fit-content" color={i.active ? 'teal' : 'gray'} variant="light">
        {i.active ? t('entity.activeBadge') : t('entity.inactiveBadge')}
      </Badge>
      <Card withBorder>
        <dl
          style={{
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            gap: '0.5rem 1.5rem',
          }}
        >
          {fields.map(([k, v]) => (
            <div key={k} style={{ display: 'contents' }}>
              <dt>
                <Text c="dimmed">{k}</Text>
              </dt>
              <dd style={{ margin: 0 }}>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card withBorder>
        <Stack>
          <Title order={2} size="h4">
            {t('items.units')}
          </Title>
          {i.units.length === 0 ? (
            <Text c="dimmed">{t('items.noUnits')}</Text>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('items.unitNameCol')}</Table.Th>
                  <Table.Th>{t('items.unitFactorCol', { base: i.baseUnit })}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {i.units.map((u) => (
                  <Table.Tr key={u.name}>
                    <Table.Td>{u.name}</Table.Td>
                    <Table.Td>{u.factor}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </Card>

      <ItemFormModal
        opened={editing}
        mode="edit"
        item={i}
        onSubmit={async (payload) => {
          await save.mutateAsync(payload);
          editCtl.close();
        }}
        onClose={editCtl.close}
      />
      <ConfirmDialog
        opened={deleting}
        title={t('items.deleteTitle')}
        message={t('items.deleteMessage', { name: i.name, barcode: i.barcode })}
        confirmLabel={t('common.delete')}
        loading={remove.isPending}
        error={delError}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: async () => {
              await qc.invalidateQueries({ queryKey: ['items'] });
              qc.removeQueries({ queryKey: ['item', id] });
              await navigate({ to: '/items', search: parseItemSearch({}) });
            },
            onError: (e) => setDelError(t(errorKey(e))),
          })
        }
        onClose={() => {
          setDelError(null);
          delCtl.close();
        }}
      />
    </Stack>
  );
};
