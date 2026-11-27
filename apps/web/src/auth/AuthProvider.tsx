import type { Permission } from '@inventory/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, refreshSession, setAccessToken, setSessionLostHandler } from '../api/client';

export interface SessionUser {
  id: string;
  companyId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
}
export type AuthState =
  | { status: 'loading' }
  | { status: 'anon' }
  | { status: 'authed'; user: SessionUser; permissions: ReadonlySet<string>; companyCode: string };

interface AuthApi {
  state: AuthState;
  login: (input: {
    companyCode: string;
    username: string;
    password: string;
  }) => Promise<SessionUser>;
  logout: () => Promise<void>;
  // بعد تغيير كلمة المرور يزول طلب التغيير. After a password change the change request clears.
  markPasswordChanged: () => void;
}
const Ctx = createContext<AuthApi | null>(null);

const COMPANY_KEY = 'inventory.company';
const rememberedCompany = (): string => {
  try {
    return localStorage.getItem(COMPANY_KEY) ?? '';
  } catch {
    return '';
  }
};

const loadPermissions = async (): Promise<ReadonlySet<string>> => {
  const res = await api.get<{ permissions: string[] }>('/permissions/mine');
  return new Set(res.data.permissions);
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // عند فتح الصفحة: الجلسة الباقية = كوكي تحديث صالح. On page load: a surviving session is a valid refresh cookie.
  useEffect(() => {
    setSessionLostHandler(() => setState({ status: 'anon' }));
    let alive = true;
    void (async () => {
      if (!(await refreshSession())) {
        if (alive) setState({ status: 'anon' });
        return;
      }
      try {
        const me = await api.get<SessionUser>('/auth/me');
        const permissions = me.data.mustChangePassword
          ? new Set<string>()
          : await loadPermissions();
        if (alive)
          setState({
            status: 'authed',
            user: me.data,
            permissions,
            companyCode: rememberedCompany(),
          });
      } catch {
        if (alive) setState({ status: 'anon' });
      }
    })();
    return () => {
      alive = false;
      setSessionLostHandler(null);
    };
  }, []);

  const login = useCallback<AuthApi['login']>(async (input) => {
    const res = await api.post<{ accessToken: string; user: SessionUser }>('/auth/login', input, {
      auth: false,
    });
    setAccessToken(res.data.accessToken);
    try {
      localStorage.setItem(COMPANY_KEY, input.companyCode);
    } catch {
      // لا بأس. Fine.
    }
    const permissions = res.data.user.mustChangePassword
      ? new Set<string>()
      : await loadPermissions();
    setState({
      status: 'authed',
      user: res.data.user,
      permissions,
      companyCode: input.companyCode,
    });
    return res.data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {}, { auth: false });
    } finally {
      setAccessToken(null);
      setState({ status: 'anon' });
    }
  }, []);

  const markPasswordChanged = useCallback(() => {
    setState((s) => {
      if (s.status !== 'authed') return s;
      return { ...s, user: { ...s.user, mustChangePassword: false } };
    });
    void loadPermissions().then((permissions) =>
      setState((s) => (s.status === 'authed' ? { ...s, permissions } : s)),
    );
  }, []);

  const value = useMemo(
    () => ({ state, login, logout, markPasswordChanged }),
    [state, login, logout, markPasswordChanged],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useAuth = (): AuthApi => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
};

// الصلاحيات للواجهة فقط (إخفاء/تعطيل)؛ الخادم هو من يفرضها. UI-only (hide/disable); the server enforces them.
export const usePermission = (permission: Permission): boolean => {
  const { state } = useAuth();
  return state.status === 'authed' && state.permissions.has(permission);
};
export const useCan = (): ((permission: Permission) => boolean) => {
  const { state } = useAuth();
  return (permission) => state.status === 'authed' && state.permissions.has(permission);
};
