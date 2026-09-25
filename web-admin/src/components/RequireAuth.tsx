import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';

import { loadSession } from '../auth/session';

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!loadSession()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
