export interface CreateImagesImageLightboxSize {
  width: number;
  height: number;
}

export interface CreateImagesImageLightboxOffset {
  x: number;
  y: number;
}

export interface CreateImagesImageLightboxView {
  zoom: number;
  offset: CreateImagesImageLightboxOffset;
}

export const CREATE_IMAGES_LIGHTBOX_MIN_ZOOM = 0.05;
export const CREATE_IMAGES_LIGHTBOX_MAX_ZOOM = 8;
export const CREATE_IMAGES_LIGHTBOX_ZOOM_FACTOR = 1.25;

function boundedNumber(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveDimension(value: number): number {
  return Math.max(1, boundedNumber(value, 1));
}

export function clampCreateImagesLightboxZoom(value: number): number {
  return Math.min(
    CREATE_IMAGES_LIGHTBOX_MAX_ZOOM,
    Math.max(CREATE_IMAGES_LIGHTBOX_MIN_ZOOM, boundedNumber(value, 1)),
  );
}

export function createImagesLightboxFitZoom(
  image: CreateImagesImageLightboxSize,
  viewport: CreateImagesImageLightboxSize,
  padding = 32,
): number {
  const availableWidth = Math.max(1, positiveDimension(viewport.width) - Math.max(0, padding) * 2);
  const availableHeight = Math.max(
    1,
    positiveDimension(viewport.height) - Math.max(0, padding) * 2,
  );
  return clampCreateImagesLightboxZoom(
    Math.min(
      1,
      availableWidth / positiveDimension(image.width),
      availableHeight / positiveDimension(image.height),
    ),
  );
}

export function clampCreateImagesLightboxOffset(
  offset: CreateImagesImageLightboxOffset,
  image: CreateImagesImageLightboxSize,
  viewport: CreateImagesImageLightboxSize,
  zoom: number,
): CreateImagesImageLightboxOffset {
  const boundedZoom = clampCreateImagesLightboxZoom(zoom);
  const overflowX = Math.max(
    0,
    (positiveDimension(image.width) * boundedZoom - positiveDimension(viewport.width)) / 2,
  );
  const overflowY = Math.max(
    0,
    (positiveDimension(image.height) * boundedZoom - positiveDimension(viewport.height)) / 2,
  );
  const x = Math.min(overflowX, Math.max(-overflowX, boundedNumber(offset.x)));
  const y = Math.min(overflowY, Math.max(-overflowY, boundedNumber(offset.y)));
  return {
    x: x === 0 ? 0 : x,
    y: y === 0 ? 0 : y,
  };
}

export function createImagesLightboxZoomAtPoint(
  view: CreateImagesImageLightboxView,
  nextZoom: number,
  anchor: CreateImagesImageLightboxOffset,
  image: CreateImagesImageLightboxSize,
  viewport: CreateImagesImageLightboxSize,
): CreateImagesImageLightboxView {
  const currentZoom = clampCreateImagesLightboxZoom(view.zoom);
  const zoom = clampCreateImagesLightboxZoom(nextZoom);
  const ratio = zoom / currentZoom;
  const offset = clampCreateImagesLightboxOffset(
    {
      x: boundedNumber(anchor.x) - (boundedNumber(anchor.x) - boundedNumber(view.offset.x)) * ratio,
      y: boundedNumber(anchor.y) - (boundedNumber(anchor.y) - boundedNumber(view.offset.y)) * ratio,
    },
    image,
    viewport,
    zoom,
  );
  return { zoom, offset };
}

export function createImagesLightboxPan(
  view: CreateImagesImageLightboxView,
  delta: CreateImagesImageLightboxOffset,
  image: CreateImagesImageLightboxSize,
  viewport: CreateImagesImageLightboxSize,
): CreateImagesImageLightboxView {
  return {
    zoom: clampCreateImagesLightboxZoom(view.zoom),
    offset: clampCreateImagesLightboxOffset(
      {
        x: boundedNumber(view.offset.x) + boundedNumber(delta.x),
        y: boundedNumber(view.offset.y) + boundedNumber(delta.y),
      },
      image,
      viewport,
      view.zoom,
    ),
  };
}
