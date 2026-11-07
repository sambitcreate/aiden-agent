import { Navigate, redirect } from "@tanstack/react-router";
import * as React from "react";
import { useAppCapabilities } from "../lib/app-capabilities";
import type { StudioFeature } from "../shared/studio-routes";

/** A studio route exists only while its capability is on; otherwise it sends the user home. */
export function StudioCapabilityRoute({
  feature,
  children,
}: React.PropsWithChildren<{ feature: StudioFeature }>) {
  const capabilities = useAppCapabilities();
  return capabilities[feature] ? <>{children}</> : <Navigate to="/" replace />;
}

/**
 * `beforeLoad` for a path whose surface was removed (Design Studio's `/design`). A stale
 * deep link or a restored window lands on the chat home instead of "Route not found".
 */
export function redirectRetiredRoute(): never {
  throw redirect({ to: "/", replace: true });
}
