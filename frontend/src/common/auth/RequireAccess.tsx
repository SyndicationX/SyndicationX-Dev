import { Navigate, Outlet } from "react-router-dom";
import { SESSION_BEARER_KEY } from "./sessionKeys";

type RequireAccessProps = {
  allowed: () => boolean;
};

/**
 * Guards an authenticated route by permission.
 *
 * `RequireAuth` normally handles the signed-out case for nested routes, but
 * this component remains safe when it is reused elsewhere.
 */
export function RequireAccess({ allowed }: RequireAccessProps) {
  const token = sessionStorage.getItem(SESSION_BEARER_KEY);
  if (!token) return <Navigate to="/signin" replace />;
  if (!allowed()) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
