import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Warehouse } from '../warehouses/types';

// خيارات المستودعات الفعّالة (حتى 100). Options of the active warehouses (up to 100).
export const useWarehouseOptions = () =>
  useQuery({
    queryKey: ['warehouses', 'options'],
    queryFn: async () =>
      (await api.get<Warehouse[]>('/warehouses?page=1&pageSize=100&active=true&sort=name')).data,
    staleTime: 60_000,
  });
