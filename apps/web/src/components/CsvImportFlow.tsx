import { IMPORT_MAX_BYTES } from '@inventory/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  FileInput,
  Group,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../api/client';
import { errorKey } from '../api/errors';
import { ConfirmDialog } from './ConfirmDialog';

interface RowError {
  line: number;
  field: string | null;
  code: string;
  message: string;
}
// تقرير مشترك؛ ما يخص كل استيراد (جديد/محدَّث…) يصل في حقول إضافية.
// A common report; each import's own counters (created/updated…) arrive as extra fields.
export interface ImportReport {
  mode: 'preview' | 'apply';
  totalRows: number;
  validRows: number;
  skipped: number;
  errorsTotal: number;
  errors: RowError[];
  errorsTruncated: boolean;
  ignoredColumns: string[];
  [extra: string]: unknown;
}

const IMPORT_ERRORS = {
  IMPORT_EMPTY_FILE: 'import.emptyFile',
  IMPORT_EMPTY: 'import.nothingValid',
  IMPORT_MISSING_COLUMNS: 'import.missingColumns',
  IMPORT_TOO_MANY_ROWS: 'import.tooManyRows',
  IMPORT_BAD_CSV: 'import.badCsv',
  IMPORT_DUPLICATE_COLUMNS: 'import.duplicateColumns',
  IMPORT_INVALID: 'import.invalidRows',
  IMPORT_CONFLICT: 'import.conflict',
  TASK_NOT_EDITABLE: 'tasks.notEditable',
  UNSUPPORTED_MEDIA_TYPE: 'import.badCsv',
  FORBIDDEN: 'common.forbidden',
};
const ROW_CODES = [
  'REQUIRED',
  'INVALID_VALUE',
  'DUPLICATE_IN_FILE',
  'SKU_TAKEN',
  'BASE_UNIT_CONFLICT',
  'ITEM_NOT_FOUND',
];

// ينزّل القالب من نص مشترك (لا طلب للخادم). Downloads the template from shared text (no server call).
const downloadTemplate = (text: string, filename: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

// معاينة أولاً ثم تطبيق بتأكيد يعرض الأثر؛ الملف يُقرأ في المتصفح ويُرسل نصاً. مشترك بين استيراد الأصناف ولقطة الرصيد.
// Preview first, then apply behind a confirmation showing the impact; the file is read in the browser and sent as text. Shared by the items import and the balance snapshot.
export const CsvImportFlow = ({
  endpoint,
  template,
  stats,
  writeCount,
  confirmMessage,
  onApplied,
  afterResult,
}: {
  endpoint: string;
  template: { text: string; filename: string };
  stats: (r: ImportReport) => [labelKey: string, value: number][];
  // كم صفاً سيُكتب فعلاً (يعطّل التطبيق إن صفر). How many rows will really be written (disables apply at zero).
  writeCount: (r: ImportReport) => number;
  confirmMessage: (r: ImportReport, t: TFunction) => string;
  onApplied?: (qc: QueryClient) => Promise<void>;
  afterResult?: React.ReactNode;
}) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = useMutation({
    mutationFn: async (mode: 'preview' | 'apply') => {
      const q = new URLSearchParams({ mode, skipInvalid: String(skipInvalid) });
      return (await api.postText<ImportReport>(`${endpoint}?${q.toString()}`, text ?? '')).data;
    },
    onSuccess: async (r) => {
      setReport(r);
      setConfirming(false);
      if (r.mode === 'apply') await onApplied?.(qc);
    },
    onError: (e) => {
      setConfirming(false);
      // رفض التطبيق بسبب أخطاء يحمل التقرير نفسه. An apply refused for invalid rows carries the report itself.
      if (e instanceof ApiError && e.code === 'IMPORT_INVALID' && e.details)
        setReport(e.details as ImportReport);
    },
  });

  const pick = async (f: File | null) => {
    setFile(f);
    setReport(null);
    setText(null);
    setFileError(null);
    run.reset();
    if (!f) return;
    if (!/\.(csv|txt)$/i.test(f.name)) return setFileError('import.badExtension');
    if (f.size > IMPORT_MAX_BYTES) return setFileError('import.tooBig');
    setText(await f.text());
  };

  const applied = report?.mode === 'apply';
  const hasErrors = (report?.errorsTotal ?? 0) > 0;
  const canApply =
    report?.mode === 'preview' && writeCount(report) > 0 && (!hasErrors || skipInvalid);

  return (
    <Stack>
      <Group>
        <Button
          variant="default"
          onClick={() => downloadTemplate(template.text, template.filename)}
        >
          {t('import.template')}
        </Button>
      </Group>

      <Card withBorder>
        <Stack>
          <FileInput
            label={t('import.file')}
            description={t('import.fileHint')}
            accept=".csv,.txt,text/csv,text/plain"
            value={file}
            onChange={(f) => void pick(f)}
            clearable
            error={fileError ? t(fileError) : undefined}
          />
          <Checkbox
            label={t('import.skipInvalid')}
            description={t('import.skipInvalidHint')}
            checked={skipInvalid}
            onChange={(e) => {
              // تغيير الخيار يبطل المعاينة: الأرقام المعروضة لم تعد تخصه. Changing it voids the preview: the shown counts no longer match.
              setSkipInvalid(e.currentTarget.checked);
              setReport(null);
              run.reset();
            }}
          />
          <Group>
            <Button
              onClick={() => run.mutate('preview')}
              disabled={text === null}
              loading={run.isPending && run.variables === 'preview'}
            >
              {t('import.preview')}
            </Button>
            <Button
              color="teal"
              onClick={() => setConfirming(true)}
              disabled={!canApply}
              loading={run.isPending && run.variables === 'apply'}
            >
              {t('import.apply')}
            </Button>
          </Group>
        </Stack>
      </Card>

      {run.isError && <Alert color="red">{t(errorKey(run.error, IMPORT_ERRORS))}</Alert>}

      {report && (
        <Card withBorder>
          <Stack>
            <Group justify="space-between">
              <Title order={2} size="h4">
                {t(applied ? 'import.resultApplied' : 'import.resultPreview')}
              </Title>
              <Badge color={applied ? 'teal' : 'gray'} variant="light">
                {t(applied ? 'import.badgeApplied' : 'import.badgePreview')}
              </Badge>
            </Group>
            <Table>
              <Table.Tbody>
                {stats(report).map(([k, v]) => (
                  <Table.Tr key={k}>
                    <Table.Th scope="row">{t(k)}</Table.Th>
                    <Table.Td>{v}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {report.ignoredColumns.length > 0 && (
              <Alert color="orange">
                {t('import.ignoredColumns', { cols: report.ignoredColumns.join('، ') })}
              </Alert>
            )}
            {report.errors.length > 0 && (
              <Stack gap="xs">
                <Text fw={600}>{t('import.errors')}</Text>
                <Table.ScrollContainer minWidth={360}>
                  <Table striped>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('import.line')}</Table.Th>
                        <Table.Th>{t('import.field')}</Table.Th>
                        <Table.Th>{t('import.problem')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {report.errors.map((e, i) => (
                        <Table.Tr key={`${e.line}-${e.field}-${i}`}>
                          <Table.Td>{e.line}</Table.Td>
                          <Table.Td>{e.field ?? '—'}</Table.Td>
                          <Table.Td>
                            {ROW_CODES.includes(e.code) ? t(`import.row.${e.code}`) : e.code}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
                {report.errorsTruncated && (
                  <Text c="dimmed" size="sm">
                    {t('import.truncated', {
                      shown: report.errors.length,
                      total: report.errorsTotal,
                    })}
                  </Text>
                )}
              </Stack>
            )}
            {!applied && hasErrors && !skipInvalid && (
              <Alert color="orange">{t('import.fixOrSkip')}</Alert>
            )}
            {applied && afterResult}
          </Stack>
        </Card>
      )}

      <ConfirmDialog
        opened={confirming}
        title={t('import.confirmTitle')}
        message={report ? confirmMessage(report, t) : ''}
        confirmLabel={t('import.apply')}
        loading={run.isPending}
        error={run.isError ? t(errorKey(run.error, IMPORT_ERRORS)) : null}
        onConfirm={() => run.mutate('apply')}
        onClose={() => setConfirming(false)}
      />
    </Stack>
  );
};
