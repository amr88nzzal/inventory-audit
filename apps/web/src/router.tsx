import { Center, Loader } from '@mantine/core';
import {
  Navigate,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useAuth } from './auth/AuthProvider';
import type { AuthState } from './auth/AuthProvider';
import { AppLayout } from './layout/AppLayout';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { WarehouseDetailPage } from './features/warehouses/WarehouseDetailPage';
import { WarehousesPage } from './features/warehouses/WarehousesPage';
import { parseWarehouseSearch } from './features/warehouses/types';
import { ItemDetailPage } from './features/items/ItemDetailPage';
import { ItemsImportPage } from './features/items/ItemsImportPage';
import { ItemsPage } from './features/items/ItemsPage';
import { parseItemSearch } from './features/items/types';
import { TaskResultsPage, parseResultsSearch } from './features/tasks/TaskResultsPage';
import { TaskScansPage, parseScansSearch } from './features/tasks/TaskScansPage';
import { TaskBalancesPage, parseBalancesSearch } from './features/tasks/TaskBalancesPage';
import { TaskDetailPage } from './features/tasks/TaskDetailPage';
import { TasksPage } from './features/tasks/TasksPage';
import { parseTaskSearch } from './features/tasks/types';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';

// حارس المسارات يقرأ حالة الجلسة من سياق الراوتر. The route guard reads the session state from the router context.
export interface AuthRef {
  current: () => AuthState;
}

const root = createRootRouteWithContext<{ auth: AuthRef }>()({ component: () => <Outlet /> });

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  beforeLoad: ({ context }) => {
    const s = context.auth.current();
    if (s.status === 'authed')
      throw redirect({ to: s.user.mustChangePassword ? '/change-password' : '/' });
  },
  // بعد نجاح الدخول تتغير الحالة فنعيد التوجيه من هنا، لا قبل أن يرى الحارس الحالة الجديدة.
  // After a successful sign-in the state changes and we redirect from here, never before the guard sees the new state.
  component: function Login() {
    const { state } = useAuth();
    if (state.status === 'authed')
      return <Navigate to={state.user.mustChangePassword ? '/change-password' : '/'} />;
    return <LoginPage />;
  },
});

const changePassword = createRoute({
  getParentRoute: () => root,
  path: '/change-password',
  beforeLoad: ({ context }) => {
    const s = context.auth.current();
    if (s.status === 'anon') throw redirect({ to: '/login' });
  },
  component: function Change() {
    const { state } = useAuth();
    if (state.status === 'authed' && !state.user.mustChangePassword) return <Navigate to="/" />;
    return <ChangePasswordPage />;
  },
});

// كل ما بعد الدخول: بلا جلسة → الدخول، وكلمة مؤقتة → تغييرها أولاً (الخادم يفرض ذلك أيضاً).
// Everything after sign-in: no session → sign-in; a temporary password → change it first (the server enforces this too).
const authed = createRoute({
  getParentRoute: () => root,
  id: 'authed',
  beforeLoad: ({ context }) => {
    const s = context.auth.current();
    if (s.status === 'anon') throw redirect({ to: '/login' });
    if (s.status === 'authed' && s.user.mustChangePassword)
      throw redirect({ to: '/change-password' });
  },
  component: AppLayout,
});
const home = createRoute({ getParentRoute: () => authed, path: '/', component: HomePage });

// المستودعات: حالة القائمة (صفحة/بحث/فلتر/فرز) في الـ URL. Warehouses: list state (page/search/filter/sort) lives in the URL.
const warehouses = createRoute({
  getParentRoute: () => authed,
  path: '/warehouses',
  validateSearch: parseWarehouseSearch,
  component: function Warehouses() {
    const search = useSearch({ from: '/authed/warehouses' });
    const navigate = useNavigate({ from: '/warehouses' });
    return (
      <WarehousesPage
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});
const warehouseDetail = createRoute({
  getParentRoute: () => authed,
  path: '/warehouses/$id',
  component: function WarehouseDetail() {
    const { id } = useParams({ from: '/authed/warehouses/$id' });
    return <WarehouseDetailPage id={id} />;
  },
});

const items = createRoute({
  getParentRoute: () => authed,
  path: '/items',
  validateSearch: parseItemSearch,
  component: function Items() {
    const search = useSearch({ from: '/authed/items' });
    const navigate = useNavigate({ from: '/items' });
    return (
      <ItemsPage
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});
// الاستيراد بصلاحيته المستقلة: من لا يملكها يرى رسالة ويُعاد للقائمة. Import has its own permission: without it the user is sent back to the list.
const itemsImport = createRoute({
  getParentRoute: () => authed,
  path: '/items/import',
  component: function ItemsImport() {
    const { state } = useAuth();
    if (state.status === 'authed' && !state.permissions.has('inventory.item.import'))
      return <Navigate to="/items" search={parseItemSearch({})} />;
    return <ItemsImportPage />;
  },
});
const itemDetail = createRoute({
  getParentRoute: () => authed,
  path: '/items/$id',
  component: function ItemDetail() {
    const { id } = useParams({ from: '/authed/items/$id' });
    return <ItemDetailPage id={id} />;
  },
});

const tasks = createRoute({
  getParentRoute: () => authed,
  path: '/tasks',
  validateSearch: parseTaskSearch,
  component: function Tasks() {
    const search = useSearch({ from: '/authed/tasks' });
    const navigate = useNavigate({ from: '/tasks' });
    return (
      <TasksPage
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});
const taskDetail = createRoute({
  getParentRoute: () => authed,
  path: '/tasks/$id',
  component: function TaskDetail() {
    const { id } = useParams({ from: '/authed/tasks/$id' });
    return <TaskDetailPage id={id} />;
  },
});

const taskBalances = createRoute({
  getParentRoute: () => authed,
  path: '/tasks/$id/balances',
  validateSearch: parseBalancesSearch,
  component: function TaskBalances() {
    const { id } = useParams({ from: '/authed/tasks/$id/balances' });
    const search = useSearch({ from: '/authed/tasks/$id/balances' });
    const navigate = useNavigate({ from: '/tasks/$id/balances' });
    return (
      <TaskBalancesPage
        id={id}
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});

const taskScans = createRoute({
  getParentRoute: () => authed,
  path: '/tasks/$id/scans',
  validateSearch: parseScansSearch,
  component: function TaskScans() {
    const { id } = useParams({ from: '/authed/tasks/$id/scans' });
    const search = useSearch({ from: '/authed/tasks/$id/scans' });
    const navigate = useNavigate({ from: '/tasks/$id/scans' });
    return (
      <TaskScansPage
        id={id}
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});

const taskResults = createRoute({
  getParentRoute: () => authed,
  path: '/tasks/$id/results',
  validateSearch: parseResultsSearch,
  component: function TaskResults() {
    const { id } = useParams({ from: '/authed/tasks/$id/results' });
    const search = useSearch({ from: '/authed/tasks/$id/results' });
    const navigate = useNavigate({ from: '/tasks/$id/results' });
    return (
      <TaskResultsPage
        id={id}
        search={search}
        onSearch={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />
    );
  },
});

const notFound = createRoute({
  getParentRoute: () => root,
  path: '*',
  component: () => <Navigate to="/" />,
});

export const routeTree = root.addChildren([
  login,
  changePassword,
  authed.addChildren([
    home,
    warehouses,
    warehouseDetail,
    items,
    itemsImport,
    itemDetail,
    tasks,
    taskDetail,
    taskBalances,
    taskScans,
    taskResults,
  ]),
  notFound,
]);

export type MakeRouterHistory = NonNullable<Parameters<typeof createRouter>[0]['history']>;
export const makeRouter = (auth: AuthRef, history?: MakeRouterHistory) =>
  createRouter({
    routeTree,
    context: { auth },
    ...(history ? { history } : {}),
    defaultPendingComponent: () => (
      <Center h="50vh">
        <Loader />
      </Center>
    ),
  });

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
