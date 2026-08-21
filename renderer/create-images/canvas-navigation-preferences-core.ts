export const CREATE_IMAGES_CANVAS_NAVIGATION_KEY =
  "aiden.create-images.canvas-navigation.v1";

export type CreateImagesCanvasNavigationMode = "classic" | "trackpad" | "selection";

export interface CreateImagesCanvasNavigationPreferences {
  version: 1;
  mode: CreateImagesCanvasNavigationMode;
  zoomOnDoubleClick: boolean;
}

export const DEFAULT_CREATE_IMAGES_CANVAS_NAVIGATION: CreateImagesCanvasNavigationPreferences =
  Object.freeze({ version: 1, mode: "classic", zoomOnDoubleClick: true });

export function parseCreateImagesCanvasNavigationPreferences(
  value: unknown,
): CreateImagesCanvasNavigationPreferences | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["version", "mode", "zoomOnDoubleClick"].includes(key),
    ) ||
    record.version !== 1 ||
    !["classic", "trackpad", "selection"].includes(record.mode as string) ||
    typeof record.zoomOnDoubleClick !== "boolean"
  ) {
    return undefined;
  }
  return {
    version: 1,
    mode: record.mode as CreateImagesCanvasNavigationMode,
    zoomOnDoubleClick: record.zoomOnDoubleClick,
  };
}

export function readCreateImagesCanvasNavigationPreferences(
  storage: Pick<Storage, "getItem">,
): CreateImagesCanvasNavigationPreferences {
  try {
    const serialized = storage.getItem(CREATE_IMAGES_CANVAS_NAVIGATION_KEY);
    if (!serialized || serialized.length > 512) return DEFAULT_CREATE_IMAGES_CANVAS_NAVIGATION;
    return (
      parseCreateImagesCanvasNavigationPreferences(JSON.parse(serialized)) ??
      DEFAULT_CREATE_IMAGES_CANVAS_NAVIGATION
    );
  } catch {
    return DEFAULT_CREATE_IMAGES_CANVAS_NAVIGATION;
  }
}

export function writeCreateImagesCanvasNavigationPreferences(
  storage: Pick<Storage, "setItem">,
  value: CreateImagesCanvasNavigationPreferences,
): void {
  const parsed = parseCreateImagesCanvasNavigationPreferences(value);
  if (!parsed) throw new Error("Invalid Create Images canvas navigation preference.");
  storage.setItem(CREATE_IMAGES_CANVAS_NAVIGATION_KEY, JSON.stringify(parsed));
}

export function createImagesCanvasNavigationProps(
  value: CreateImagesCanvasNavigationPreferences,
): {
  panOnDrag: boolean | number[];
  panOnScroll: boolean;
  selectionOnDrag: boolean;
  zoomOnScroll: boolean;
  zoomOnPinch: boolean;
  zoomOnDoubleClick: boolean;
} {
  if (value.mode === "trackpad") {
    return {
      panOnDrag: [1, 2],
      panOnScroll: true,
      selectionOnDrag: false,
      zoomOnScroll: false,
      zoomOnPinch: true,
      zoomOnDoubleClick: value.zoomOnDoubleClick,
    };
  }
  if (value.mode === "selection") {
    return {
      panOnDrag: [1, 2],
      panOnScroll: false,
      selectionOnDrag: true,
      zoomOnScroll: true,
      zoomOnPinch: true,
      zoomOnDoubleClick: value.zoomOnDoubleClick,
    };
  }
  return {
    panOnDrag: true,
    panOnScroll: true,
    selectionOnDrag: true,
    zoomOnScroll: true,
    zoomOnPinch: true,
    zoomOnDoubleClick: value.zoomOnDoubleClick,
  };
}
