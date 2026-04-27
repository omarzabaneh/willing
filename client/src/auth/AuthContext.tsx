import * as jose from 'jose';
import { createContext, useState, useCallback, type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import requestServer from '../utils/requestServer';

import type { AdminLoginResponse, AdminMeResponse, AdminResetPasswordResponse, OrganizationGetMeResponse, OrganizationResetPasswordResponse, UserDeleteAccountResponse, UserLoginResponse, VolunteerCreateResponse, VolunteerMeResponse, VolunteerResendVerificationResponse, VolunteerResetPasswordResponse, VolunteerVerifyEmailResponse } from '../../../server/src/api/types';
import type { AdminAccountWithoutPassword, NewVolunteerAccount, OrganizationAccountWithoutPassword, VolunteerAccountWithoutPassword } from '../../../server/src/db/tables';
import type { Role, UserJWT } from '../../../server/src/types';

type AccountWithoutPassword = AdminAccountWithoutPassword | OrganizationAccountWithoutPassword | VolunteerAccountWithoutPassword;

const JWT_STORAGE_KEY = 'jwt';
const AUTH_EVENT_KEY = 'auth-event';

const getCurrentUserAccount = async (currentRole?: Role) => {
  if (!currentRole) {
    const token = localStorage.getItem(JWT_STORAGE_KEY);
    if (!token) return undefined;

    const decoded = jose.decodeJwt<UserJWT>(token);
    currentRole = decoded.role;
  }

  if (currentRole === 'admin') {
    const response = await requestServer<AdminMeResponse>('/admin/me', { includeJwt: true });
    return response.admin;
  }

  if (currentRole === 'organization') {
    const response = await requestServer<OrganizationGetMeResponse>('/organization/me', { includeJwt: true });
    return response.organization;
  }

  if (currentRole === 'volunteer') {
    const response = await requestServer<VolunteerMeResponse>('/volunteer/me', { includeJwt: true });
    return response.volunteer;
  }

  return undefined;
};

export type AuthContextType = {
  user?: {
    role: Role;
    account?: AccountWithoutPassword;
  };
  loaded: boolean;
  refreshUser: (jwt?: string) => void;
  loginAdmin: (email: string, password: string) => Promise<void>;
  loginUser: (email: string, password: string) => Promise<void>;
  createVolunteer: (volunteer: NewVolunteerAccount) => Promise<VolunteerCreateResponse>;
  verifyVolunteerEmail: (key: string) => Promise<VolunteerVerifyEmailResponse>;
  resendVolunteerVerification: (email: string) => Promise<void>;
  changePassword: (oldPassword: string, newPassword: string) => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  logout: () => void;
  restrictRoute: (role: Role, unauthenticatedRedirectPath: string) => AccountWithoutPassword;
};

const AuthContext = createContext<AuthContextType>({
  user: undefined,
  loaded: false,
  refreshUser: () => {},
  loginAdmin: async () => {},
  loginUser: async () => {},
  createVolunteer: async () => ({ requires_email_verification: true }),
  verifyVolunteerEmail: async () => ({ volunteer: {} as VolunteerAccountWithoutPassword, token: '' }),
  resendVolunteerVerification: async () => {},
  changePassword: async () => {},
  deleteAccount: async () => {},
  logout: () => {},
  restrictRoute: (() => {
    return undefined as unknown as AccountWithoutPassword;
  }) as AuthContextType['restrictRoute'],
});

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const navigate = useNavigate();

  const [user, setUser] = useState<AuthContextType['user']>(() => {
    const token = localStorage.getItem(JWT_STORAGE_KEY);
    if (!token) return undefined;

    return {
      role: jose.decodeJwt<UserJWT>(token).role,
      account: undefined as AccountWithoutPassword | undefined,
    };
  });
  const [loaded, setLoaded] = useState(false);

  const refreshUser = useCallback(async (jwt?: string) => {
    const tokenFromLocal = localStorage.getItem(JWT_STORAGE_KEY);
    const token = jwt || tokenFromLocal;

    if (!token) {
      setUser(undefined);
      return;
    }

    if (!tokenFromLocal) {
      localStorage.setItem(JWT_STORAGE_KEY, token);
    }

    try {
      const { role } = jose.decodeJwt<UserJWT>(token);
      const account = await getCurrentUserAccount(role);
      if (!account) {
        localStorage.removeItem('jwt');
        setUser(undefined);
        navigate('/login', { replace: true });
        return;
      }

      setUser({ role, account: account });
    } catch {
      localStorage.removeItem('jwt');
      setUser(undefined);
      navigate('/login', { replace: true });
    }
  }, [navigate]);
  useEffect(() => {
    refreshUser().then(() => setLoaded(true));
  }, [refreshUser]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AUTH_EVENT_KEY || !event.newValue) return;

      if (event.newValue.startsWith('signout-others')) {
        if (localStorage.getItem(JWT_STORAGE_KEY)) {
          localStorage.removeItem(JWT_STORAGE_KEY);
          setUser(undefined);
          navigate('/login', { replace: true });
        }
        return;
      }

      if (event.newValue.startsWith('login-')) {
        // event format: login-<role>-<id>-<timestamp>
        const [, eventRole, eventId] = event.newValue.split('-');
        if (!eventRole || !eventId) return;

        const localToken = localStorage.getItem(JWT_STORAGE_KEY);
        if (!localToken) return;

        const currentRole = user?.role;
        const currentId = user?.account?.id?.toString();

        if (currentRole === eventRole && currentId === eventId) return;

        void refreshUser(localToken);
      }
    };

    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('storage', onStorage);
    };
  }, [navigate, user]);

  const loginAdmin = useCallback(async (email: string, password: string) => {
    try {
      const response = await requestServer<AdminLoginResponse>('/admin/login', {
        method: 'POST',
        body: { email, password },
      });

      localStorage.setItem(JWT_STORAGE_KEY, response.token);
      setUser({ role: 'admin', account: response.admin });
      window.localStorage.setItem(AUTH_EVENT_KEY, `login-admin-${response.admin.id}-${Date.now()}`);
    } catch (error) {
      localStorage.removeItem(JWT_STORAGE_KEY);
      throw error;
    }
  }, []);

  const loginUser = useCallback(async (email: string, password: string) => {
    try {
      const response = await requestServer<UserLoginResponse>('/user/login', {
        method: 'POST',
        body: { email, password },
      });

      localStorage.setItem(JWT_STORAGE_KEY, response.token);
      const account = response.role === 'organization' ? response.organization! : response.volunteer!;
      setUser({
        role: response.role,
        account,
      });
      window.localStorage.setItem(AUTH_EVENT_KEY, `login-${response.role}-${account.id}-${Date.now()}`);
    } catch (error) {
      localStorage.removeItem(JWT_STORAGE_KEY);
      throw error;
    }
  }, []);

  const createVolunteer = useCallback(async (volunteer: NewVolunteerAccount) => {
    const response = await requestServer<VolunteerCreateResponse>('/volunteer/create', {
      method: 'POST',
      body: volunteer,
    });

    return response;
  }, []);

  const verifyVolunteerEmail = useCallback(async (key: string) => {
    try {
      const response = await requestServer<VolunteerVerifyEmailResponse>('/volunteer/verify-email', {
        method: 'POST',
        body: { key },
      });

      localStorage.setItem(JWT_STORAGE_KEY, response.token);
      setUser({
        role: 'volunteer',
        account: response.volunteer,
      });
      window.localStorage.setItem(AUTH_EVENT_KEY, `login-volunteer-${response.volunteer.id}-${Date.now()}`);

      return response;
    } catch (error) {
      localStorage.removeItem(JWT_STORAGE_KEY);
      throw error;
    }
  }, []);

  const resendVolunteerVerification = useCallback(async (email: string) => {
    await requestServer<VolunteerResendVerificationResponse>('/volunteer/resend-verification', {
      method: 'POST',
      body: { email },
    });
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    if (!user) return;

    const { token } = await requestServer<
      AdminResetPasswordResponse
      | VolunteerResetPasswordResponse
      | OrganizationResetPasswordResponse
    >('/' + user!.role + '/reset-password', {
      method: 'POST',
      body: {
        currentPassword,
        newPassword,
      },
      includeJwt: true,
    });

    localStorage.setItem(JWT_STORAGE_KEY, token);
    window.localStorage.setItem(AUTH_EVENT_KEY, 'signout-others-' + Date.now());
    await refreshUser(token);
  }, [user, refreshUser]);

  const logout = useCallback(() => {
    localStorage.removeItem(JWT_STORAGE_KEY);
    window.localStorage.setItem(AUTH_EVENT_KEY, 'signout-others-' + Date.now());
    setUser(undefined);
  }, [user]);

  const deleteAccount = useCallback(async (password: string) => {
    const now = new Date();
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const localTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:00`;

    await requestServer<UserDeleteAccountResponse>('/user/account', {
      method: 'DELETE',
      includeJwt: true,
      body: {
        password,
        local_date: localDate,
        local_time: localTime,
      },
    });

    logout();
  }, [logout]);

  const restrictRoute = useCallback((allowedRole: Role, unauthenticatedRedirectPath: string) => {
    if (!user) {
      navigate(unauthenticatedRedirectPath, { replace: true });
    } else if (user.role !== allowedRole) {
      navigate('/' + user.role, { replace: true });
    }

    if (allowedRole === 'admin') {
      return user!.account as AdminAccountWithoutPassword;
    } else if (allowedRole === 'organization') {
      return user!.account as OrganizationAccountWithoutPassword;
    } else if (allowedRole === 'volunteer') {
      return user!.account as VolunteerAccountWithoutPassword;
    }
    return undefined as unknown as AccountWithoutPassword;
  }, [user, navigate]);

  return (
    <AuthContext.Provider value={{ user, loaded, refreshUser, loginAdmin, loginUser, createVolunteer, verifyVolunteerEmail, resendVolunteerVerification, changePassword, deleteAccount, logout, restrictRoute }}>
      {children}
    </AuthContext.Provider>
  );
};

export default AuthContext;
