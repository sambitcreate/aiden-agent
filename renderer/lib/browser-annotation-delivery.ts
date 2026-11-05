import type { BrowserAnnotation } from "../shared/browser";
import { ComposerDeliveryRegistry, type ComposerRecipient } from "./composer-delivery";

export type BrowserAnnotationRecipient = ComposerRecipient<BrowserAnnotation>;

/** Main validates page context; this document acknowledges the actual draft write. */
export class BrowserAnnotationDeliveryRegistry extends ComposerDeliveryRegistry<BrowserAnnotation> {}

export const browserAnnotationDelivery = new BrowserAnnotationDeliveryRegistry();
export const BROWSER_ANNOTATION_UNAVAILABLE = "The chat composer is not available. Finish the current question or return to a chat, then add this annotation again. Your selection is kept here.";
