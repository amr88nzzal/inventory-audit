import { ITEMS_IMPORT_TEMPLATE } from '@inventory/shared';
import { Anchor, List, Stack, Text, Title } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { CsvImportFlow } from '../../components/CsvImportFlow';
import type { ImportReport } from '../../components/CsvImportFlow';

const num = (r: ImportReport, k: string): number => Number(r[k] ?? 0);

export const ItemsImportPage = () => {
  const { t } = useTranslation();
  return (
    <Stack>
      <Anchor component={Link} to="/items">
        {t('items.back')}
      </Anchor>
      <Title order={1} size="h2">
        {t('import.title')}
      </Title>
      <Text c="dimmed">{t('import.intro')}</Text>
      <CsvImportFlow
        endpoint="/items/import"
        template={{ text: ITEMS_IMPORT_TEMPLATE, filename: 'items-template.csv' }}
        stats={(r) => [
          ['import.stat.totalRows', r.totalRows],
          ['import.stat.created', num(r, 'created')],
          ['import.stat.updated', num(r, 'updated')],
          ['import.stat.unchanged', num(r, 'unchanged')],
          ['import.stat.skipped', r.skipped],
          ['import.stat.errorsTotal', r.errorsTotal],
        ]}
        writeCount={(r) => num(r, 'created') + num(r, 'updated')}
        confirmMessage={(r, tr) =>
          tr('import.confirmMessage', {
            created: num(r, 'created'),
            updated: num(r, 'updated'),
            skipped: r.skipped,
          })
        }
        onApplied={(qc) => qc.invalidateQueries({ queryKey: ['items'] })}
        afterResult={
          <List>
            <List.Item>
              <Anchor component={Link} to="/items">
                {t('import.viewItems')}
              </Anchor>
            </List.Item>
          </List>
        }
      />
    </Stack>
  );
};
