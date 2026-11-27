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
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { api, ApiError } from '../../api/client';
import { errorKey } from '../../api/errors';
import { usePermission } from '../../auth/AuthProvider';
import { EntityFormModal } from './EntityFormModal';
import { WAREHOUSE_ERRORS } from './WarehousesPage';
import { parseWarehouseSearch } from './types';
import type { Location, Warehouse } from './types';

const LOCATION_ERRORS = {
  ...WAREHOUSE_ERRORS,
  LOCATION_CODE_TAKEN: 'warehouses.locationCodeTaken',
};

export const WarehouseDetailPage = ({ id }: { id: string }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canUpdate = usePermission('inventory.warehouse.update');
  const canDelete = usePermission('inventory.warehouse.delete');

  const wh = useQuery({
    queryKey: ['warehouse', id],
    queryFn: async () => (await api.get<Warehouse>(`/warehouses/${id}`)).data,
    retry: false,
  });
  const locs = useQuery({
    queryKey: ['locations', id],
    queryFn: async () => (await api.get<Location[]>(`/warehouses/${id}/locations`)).data,
    enabled: wh.isSuccess,
  });

  const [editWh, editWhCtl] = useDisclosure();
  const [addLoc, addLocCtl] = useDisclosure();
  const [editLoc, setEditLoc] = useState<Location | null>(null);
  const [delLoc, setDelLoc] = useState<Location | null>(null);
  const [delWh, delWhCtl] = useDisclosure();
  const [delError, setDelError] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['warehouse', id] }),
      qc.invalidateQueries({ queryKey: ['locations', id] }),
      qc.invalidateQueries({ queryKey: ['warehouses'] }),
    ]);
  };
  const saveWh = useMutation({
    mutationFn: (v: { name: string; active: boolean; version: number }) =>
      api.patch(`/warehouses/${id}`, v),
    onSuccess: refresh,
  });
  const addLocation = useMutation({
    mutationFn: (v: { code: string; name: string }) => api.post(`/warehouses/${id}/locations`, v),
    onSuccess: refresh,
  });
  const saveLocation = useMutation({
    mutationFn: (v: { loc: Location; name: string; active: boolean }) =>
      api.patch(`/warehouses/${id}/locations/${v.loc.id}`, {
        version: v.loc.version,
        name: v.name,
        active: v.active,
      }),
    onSuccess: refresh,
  });
  const removeLocation = useMutation({
    mutationFn: (loc: Location) => api.del(`/warehouses/${id}/locations/${loc.id}`),
    onSuccess: refresh,
  });
  const removeWh = useMutation({
    mutationFn: () => api.del(`/warehouses/${id}`),
  });

  // خارج النطاق أو غير موجود: 404 واحد لا يكشف شيئاً. Out of scope or missing: one 404 that reveals nothing.
  if (wh.isError)
    return (
      <Stack>
        <Alert color="red">
          {t(
            wh.error instanceof ApiError && wh.error.status === 404
              ? 'warehouses.notFound'
              : errorKey(wh.error),
          )}
        </Alert>
        <Anchor component={Link} to="/warehouses">
          {t('warehouses.back')}
        </Anchor>
      </Stack>
    );
  if (!wh.data) return <Skeleton height={160} />;
  const w = wh.data;
  const rows = locs.data ?? [];

  return (
    <Stack>
      <Anchor component={Link} to="/warehouses">
        {t('warehouses.back')}
      </Anchor>
      <Group justify="space-between">
        <Title order={1} size="h2">
          {w.code} — {w.name}
        </Title>
        <Group>
          {canUpdate && (
            <Button variant="default" onClick={editWhCtl.open}>
              {t('common.edit')}
            </Button>
          )}
          {canDelete && (
            <Button color="red" variant="light" onClick={delWhCtl.open}>
              {t('common.delete')}
            </Button>
          )}
        </Group>
      </Group>
      <Badge w="fit-content" color={w.active ? 'teal' : 'gray'} variant="light">
        {w.active ? t('entity.activeBadge') : t('entity.inactiveBadge')}
      </Badge>

      <Card withBorder>
        <Stack>
          <Group justify="space-between">
            <Title order={2} size="h4">
              {t('warehouses.locations')}
            </Title>
            {canUpdate && <Button onClick={addLocCtl.open}>{t('warehouses.addLocation')}</Button>}
          </Group>
          {locs.isError && <Alert color="red">{t(errorKey(locs.error))}</Alert>}
          {rows.length === 0 && locs.isSuccess && (
            <Text c="dimmed">{t('warehouses.noLocations')}</Text>
          )}
          {rows.length > 0 && (
            <Table.ScrollContainer minWidth={360}>
              <Table striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('entity.code')}</Table.Th>
                    <Table.Th>{t('entity.name')}</Table.Th>
                    <Table.Th>{t('entity.status')}</Table.Th>
                    {canUpdate && <Table.Th>{t('common.actions')}</Table.Th>}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((l) => (
                    <Table.Tr key={l.id}>
                      <Table.Td>{l.code}</Table.Td>
                      <Table.Td>{l.name}</Table.Td>
                      <Table.Td>
                        <Badge color={l.active ? 'teal' : 'gray'} variant="light">
                          {l.active ? t('entity.activeBadge') : t('entity.inactiveBadge')}
                        </Badge>
                      </Table.Td>
                      {canUpdate && (
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            <Button
                              size="compact-sm"
                              variant="default"
                              onClick={() => setEditLoc(l)}
                              aria-label={`${t('common.edit')} ${l.code}`}
                            >
                              {t('common.edit')}
                            </Button>
                            <Button
                              size="compact-sm"
                              color="red"
                              variant="light"
                              onClick={() => setDelLoc(l)}
                              aria-label={`${t('common.delete')} ${l.code}`}
                            >
                              {t('common.delete')}
                            </Button>
                          </Group>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      </Card>

      <EntityFormModal
        opened={editWh}
        mode="edit"
        initial={w}
        title={t('warehouses.edit')}
        errorMap={WAREHOUSE_ERRORS}
        onSubmit={async (v) => {
          await saveWh.mutateAsync({ name: v.name, active: v.active, version: w.version });
          editWhCtl.close();
        }}
        onClose={editWhCtl.close}
      />
      <EntityFormModal
        opened={addLoc}
        mode="create"
        title={t('warehouses.addLocation')}
        errorMap={LOCATION_ERRORS}
        onSubmit={async (v) => {
          await addLocation.mutateAsync({ code: v.code, name: v.name });
          addLocCtl.close();
        }}
        onClose={addLocCtl.close}
      />
      <EntityFormModal
        opened={editLoc !== null}
        mode="edit"
        {...(editLoc ? { initial: editLoc } : {})}
        title={t('warehouses.editLocation')}
        errorMap={LOCATION_ERRORS}
        onSubmit={async (v) => {
          if (!editLoc) return;
          await saveLocation.mutateAsync({ loc: editLoc, name: v.name, active: v.active });
          setEditLoc(null);
        }}
        onClose={() => setEditLoc(null)}
      />
      <ConfirmDialog
        opened={delLoc !== null}
        title={t('warehouses.deleteLocationTitle')}
        message={t('warehouses.deleteLocationMessage', { code: delLoc?.code ?? '' })}
        confirmLabel={t('common.delete')}
        loading={removeLocation.isPending}
        error={removeLocation.isError ? t(errorKey(removeLocation.error)) : null}
        onConfirm={() =>
          delLoc && removeLocation.mutate(delLoc, { onSuccess: () => setDelLoc(null) })
        }
        onClose={() => {
          removeLocation.reset();
          setDelLoc(null);
        }}
      />
      <ConfirmDialog
        opened={delWh}
        title={t('warehouses.deleteTitle')}
        message={t('warehouses.deleteMessage', { code: w.code, count: rows.length })}
        confirmLabel={t('common.delete')}
        loading={removeWh.isPending}
        error={delError}
        onConfirm={() =>
          removeWh.mutate(undefined, {
            onSuccess: async () => {
              await qc.invalidateQueries({ queryKey: ['warehouses'] });
              qc.removeQueries({ queryKey: ['warehouse', id] });
              await navigate({ to: '/warehouses', search: parseWarehouseSearch({}) });
            },
            onError: (e) => setDelError(t(errorKey(e))),
          })
        }
        onClose={() => {
          setDelError(null);
          delWhCtl.close();
        }}
      />
    </Stack>
  );
};
