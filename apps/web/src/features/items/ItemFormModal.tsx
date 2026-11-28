import { createItemSchema, updateItemSchema } from '@inventory/shared';
import { Button, Group, Modal, ScrollArea, Stack, Switch, Text, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { errorKey } from '../../api/errors';
import type { Item } from './types';

interface FormValues {
  barcode: string;
  sku: string;
  name: string;
  price: string;
  supplier: string;
  category: string;
  accountNo: string;
  baseUnit: string;
  tolerancePct: string;
  active: boolean;
  units: { name: string; factor: string }[];
}
export type ItemPayload = Record<string, unknown>;

const OPTIONAL = ['sku', 'price', 'supplier', 'category', 'accountNo', 'tolerancePct'] as const;
export const ITEM_ERRORS = {
  BARCODE_TAKEN: 'items.barcodeTaken',
  SKU_TAKEN: 'items.skuTaken',
  VERSION_CONFLICT: 'items.versionConflict',
  VALIDATION_ERROR: 'items.unitsInvalid',
  FORBIDDEN: 'common.forbidden',
};

const empty: FormValues = {
  barcode: '',
  sku: '',
  name: '',
  price: '',
  supplier: '',
  category: '',
  accountNo: '',
  baseUnit: '',
  tolerancePct: '',
  active: true,
  units: [],
};
const fromItem = (i: Item): FormValues => ({
  barcode: i.barcode,
  sku: i.sku ?? '',
  name: i.name,
  price: i.price ?? '',
  supplier: i.supplier ?? '',
  category: i.category ?? '',
  accountNo: i.accountNo ?? '',
  baseUnit: i.baseUnit,
  tolerancePct: i.tolerancePct ?? '',
  active: i.active,
  units: i.units,
});

// نبني الحمولة ثم نمرّرها على مخطط الخادم نفسه (shared) فلا تتباعد القواعد.
// Build the payload, then run it through the server's own schema (shared) so the rules never drift.
const payloadOf = (v: FormValues, mode: 'create' | 'edit', version: number): ItemPayload => {
  const base: ItemPayload = {
    barcode: v.barcode,
    name: v.name,
    units: v.units,
  };
  // الفارغ يترك الافتراضي في الخادم عند الإنشاء. Empty leaves the server default on create.
  if (v.baseUnit.trim() !== '') base['baseUnit'] = v.baseUnit;
  for (const k of OPTIONAL) {
    const val = v[k].trim();
    if (mode === 'edit') base[k] = val === '' ? null : val;
    else if (val !== '') base[k] = val;
  }
  if (mode === 'edit') {
    base['version'] = version;
    base['active'] = v.active;
  }
  return base;
};

export const ItemFormModal = ({
  opened,
  mode,
  item,
  onSubmit,
  onClose,
}: {
  opened: boolean;
  mode: 'create' | 'edit';
  item?: Item;
  onSubmit: (payload: ItemPayload) => Promise<void>;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    setValue,
    setError: setFieldError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty });
  const units = useFieldArray({ control, name: 'units' });
  useEffect(() => {
    if (opened) {
      reset(item ? fromItem(item) : empty);
      setError(null);
    }
  }, [opened, item, reset]);

  const submit = handleSubmit(async (v) => {
    setError(null);
    const payload = payloadOf(v, mode, item?.version ?? 1);
    const parsed = (mode === 'create' ? createItemSchema : updateItemSchema).safeParse(payload);
    if (!parsed.success) {
      let general = false;
      for (const issue of parsed.error.issues) {
        const [head, idx, leaf] = issue.path;
        if (head === 'units' && typeof idx === 'number' && typeof leaf === 'string')
          setFieldError(`units.${idx}.${leaf}` as 'units.0.name', { message: 'invalid' });
        else if (typeof head === 'string' && head in empty && head !== 'units')
          setFieldError(head as keyof FormValues, { message: 'invalid' });
        else general = true;
      }
      if (general) setError('items.unitsInvalid');
      return;
    }
    try {
      await onSubmit(payload);
    } catch (e) {
      setError(errorKey(e, ITEM_ERRORS));
    }
  });

  const text = (
    name: keyof Omit<FormValues, 'units' | 'active'>,
    label: string,
    required = false,
  ) => (
    <TextInput
      label={label}
      required={required}
      {...register(name)}
      error={errors[name] ? t('items.fieldInvalid') : undefined}
    />
  );

  return (
    <Modal
      closeButtonProps={{ 'aria-label': t('common.closeDialog') }}
      opened={opened}
      onClose={onClose}
      title={t(mode === 'create' ? 'items.add' : 'items.edit')}
      centered
      size="lg"
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <form onSubmit={submit} noValidate>
        <Stack>
          {text('barcode', t('items.barcode'), true)}
          {text('name', t('items.name'), true)}
          <Group grow align="flex-start">
            {text('sku', t('items.sku'))}
            {text('category', t('items.category'))}
          </Group>
          <Group grow align="flex-start">
            {text('supplier', t('items.supplier'))}
            {text('accountNo', t('items.accountNo'))}
          </Group>
          <Group grow align="flex-start">
            {text('price', t('items.price'))}
            {text('tolerancePct', t('items.tolerancePct'))}
          </Group>
          {text('baseUnit', t('items.baseUnit'), mode === 'edit')}

          <Stack gap="xs">
            <Text fw={600}>{t('items.units')}</Text>
            <Text size="sm" c="dimmed">
              {t('items.unitsHint')}
            </Text>
            {units.fields.map((f, i) => (
              <Group key={f.id} align="flex-start" wrap="nowrap">
                <TextInput
                  aria-label={t('items.unitName', { n: i + 1 })}
                  placeholder={t('items.unitNamePh')}
                  {...register(`units.${i}.name`)}
                  error={errors.units?.[i]?.name ? t('items.fieldInvalid') : undefined}
                />
                <TextInput
                  aria-label={t('items.unitFactor', { n: i + 1 })}
                  placeholder={t('items.unitFactorPh')}
                  {...register(`units.${i}.factor`)}
                  error={errors.units?.[i]?.factor ? t('items.factorInvalid') : undefined}
                />
                <Button
                  variant="light"
                  color="red"
                  onClick={() => units.remove(i)}
                  aria-label={t('items.removeUnit', { n: i + 1 })}
                >
                  {t('common.delete')}
                </Button>
              </Group>
            ))}
            <Button
              variant="default"
              w="fit-content"
              onClick={() => units.append({ name: '', factor: '' })}
              disabled={units.fields.length >= 10}
            >
              {t('items.addUnit')}
            </Button>
          </Stack>

          {mode === 'edit' && (
            <Switch
              label={t('entity.active')}
              checked={watch('active')}
              onChange={(e) => setValue('active', e.currentTarget.checked)}
            />
          )}
          {error && (
            <div role="alert" style={{ color: 'var(--mantine-color-red-7)' }}>
              {t(error)}
            </div>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={isSubmitting}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
};
