import { Table, UnstyledButton } from '@mantine/core';

// عنوان عمود قابل للفرز مع aria-sort. A sortable column header with aria-sort.
export const SortableTh = ({
  label,
  active,
  dir,
  onSort,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onSort: () => void;
}) => (
  <Table.Th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <UnstyledButton onClick={onSort} fw={600}>
      {label}
      {active ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </UnstyledButton>
  </Table.Th>
);
