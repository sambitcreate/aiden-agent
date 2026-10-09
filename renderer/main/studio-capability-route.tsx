import { Navigate } from "@tanstack/react-router";
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
