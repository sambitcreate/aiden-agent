export type StudioFeature = "designStudio" | "createImages";

/** Root path of each studio surface; nested routes live under the root. */
export const STUDIO_ROUTE_ROOTS = Object.freeze({
  designStudio: "/design",
  createImages: "/images",
} as const satisfies Record<StudioFeature, string>);

const FEATURES = Object.keys(STUDIO_ROUTE_ROOTS) as StudioFeature[];

export function studioFeatureForPath(pathname: string): StudioFeature | null {
  for (const feature of FEATURES) {
    const root = STUDIO_ROUTE_ROOTS[feature];
    if (pathname === root || pathname.startsWith(`${root}/`)) return feature;
  }
  return null;
}

export function isStudioPath(pathname: string): boolean {
  return studioFeatureForPath(pathname) !== null;
}
