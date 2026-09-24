import { createContext, useContext, type ReactNode } from 'react';
import type { StaffRole, StaffUserDTO } from '@sp/shared';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type MeResponse } from './api/client';
import { qk } from './api/queries';

const ROLE_RANK: Record<StaffRole, number> = { reviewer: 0, admin: 1, owner: 2 };

export function roleAtLeast(role: StaffRole | undefined | null, min: StaffRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

interface AuthValue {
  user: StaffUserDTO;
  org: { id: string; name: string };
  isAdmin: boolean;
  isOwner: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  const value: AuthValue = {
    user: me.user,
    org: me.org,
    isAdmin: roleAtLeast(me.user.role, 'admin'),
    isOwner: me.user.role === 'owner',
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Renders children only for users with at least `role`. */
export function RoleGate({ role, children, fallback = null }: { role: StaffRole; children: ReactNode; fallback?: ReactNode }) {
  const { user } = useAuth();
  return <>{roleAtLeast(user.role, role) ? children : fallback}</>;
}

/** Loads the current staff user (null when not signed in). */
export function useMe() {
  return useQuery<MeResponse | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}
