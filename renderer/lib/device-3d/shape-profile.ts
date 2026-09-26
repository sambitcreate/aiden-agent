// Adapted from t3code packages/client-runtime/src/device/shapeProfile.ts @ 1c127066 (MIT).
// iOS families only; Aiden never bundles vendor device models.

export interface DeviceShapeProfile {
  readonly id: "ios-phone" | "ios-tablet";
  readonly bezel: number;
  readonly bodyRadius: number;
  readonly screenRadius: number;
  readonly depth: number;
  readonly backColor: number;
  readonly buttons: ReadonlyArray<{
    readonly edge: "left" | "right" | "top";
    readonly offset: number;
    readonly length: number;
  }>;
  readonly camera: {
    readonly width: number;
    readonly height: number;
    readonly insetX: number;
    readonly insetY: number;
    readonly lensRadius: number;
    readonly lenses: ReadonlyArray<readonly [number, number]>;
    readonly flash: readonly [number, number] | null;
  };
}

/** Original family silhouettes, rather than claims to reproduce individual hardware models. */
export const IOS_PHONE_SHAPE: DeviceShapeProfile = {
  id: "ios-phone",
  bezel: 0.055,
  bodyRadius: 0.15,
  screenRadius: 0.105,
  depth: 0.085,
  backColor: 0x424b5d,
  buttons: [
    { edge: "right", offset: 0.35, length: 0.3 },
    { edge: "left", offset: 0.48, length: 0.18 },
    { edge: "left", offset: 0.22, length: 0.18 },
  ],
  camera: {
    width: 0.39,
    height: 0.44,
    insetX: 0.25,
    insetY: 0.29,
    lensRadius: 0.068,
    lenses: [
      [-0.08, 0.095],
      [0.08, -0.095],
    ],
    flash: [0.085, 0.11],
  },
};

export const IOS_TABLET_SHAPE: DeviceShapeProfile = {
  id: "ios-tablet",
  bezel: 0.065,
  bodyRadius: 0.105,
  screenRadius: 0.045,
  depth: 0.055,
  backColor: 0x9ca5af,
  buttons: [
    { edge: "top", offset: 0.5, length: 0.15 },
    { edge: "right", offset: 0.78, length: 0.13 },
    { edge: "right", offset: 0.58, length: 0.13 },
  ],
  camera: {
    width: 0.19,
    height: 0.19,
    insetX: 0.15,
    insetY: 0.15,
    lensRadius: 0.045,
    lenses: [[0, 0]],
    flash: null,
  },
};

/** The simulator's kind wins; unknown devices use the screen's portrait aspect. */
export function resolveDeviceShape(kind: "iphone" | "ipad" | "other", portraitAspect: number): DeviceShapeProfile {
  if (kind === "ipad") return IOS_TABLET_SHAPE;
  if (kind === "iphone") return IOS_PHONE_SHAPE;
  return Number.isFinite(portraitAspect) && portraitAspect >= 0.6 ? IOS_TABLET_SHAPE : IOS_PHONE_SHAPE;
}
