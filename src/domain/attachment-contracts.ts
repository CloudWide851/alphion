export const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  perMessage: 8,
  perImageBytes: 20 * 1024 * 1024,
  perMessageBytes: 80 * 1024 * 1024,
  maxDimension: 32_768,
  maxPixels: 100_000_000,
} as const);

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** Safe metadata stored with messages. It never contains a local path or binary payload. */
export interface ImageAttachmentRef {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly domainId: string;
  readonly projectId?: string;
  readonly digest: string;
  readonly mediaType: ImageMediaType;
  readonly byteSize: number;
  readonly width: number;
  readonly height: number;
  readonly fileName: string;
}

export interface StoredImageAttachment extends ImageAttachmentRef {
  readonly storageKey: string;
  readonly createdAt: string;
  readonly referencedAt?: string;
}

/** Versioned public input accepted by send, steer, and follow-up. */
export interface SessionMessageInput {
  readonly schemaVersion: 1;
  readonly text?: string;
  readonly attachments?: readonly ImageAttachmentRef[];
}

export type ProviderUserContentPart =
  | Readonly<{ readonly type: "text"; readonly text: string }>
  | Readonly<{ readonly type: "image"; readonly attachment: ImageAttachmentRef }>;

export interface AttachmentImportInput {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}
