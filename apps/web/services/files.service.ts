import { apiClient } from './api-client';

export type FilePurpose =
  | 'COMPANY_LOGO'
  | 'BRANCH_IMAGE'
  | 'EMPLOYEE_PHOTO'
  | 'SERVICE_IMAGE'
  | 'CUSTOMER_PHOTO';

export interface StoredFile {
  id: string;
  purpose: FilePurpose;
  targetId: string | null;
  visibility: 'PUBLIC' | 'PRIVATE';
  fileName: string;
  /** Detected by the server from the content, after re-encoding. */
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  /** Public URL, or a signed URL for a private file (see urlExpiresAt). */
  url: string;
  urlExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the server accepts. Checked here only to fail fast; the server decides. */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const base = (companyId: string) => `/companies/${companyId}/files`;

export const filesService = {
  /** Upload and attach in one request. `onProgress` gets 0–1. */
  upload: (
    companyId: string,
    input: { purpose: FilePurpose; targetId?: string; file: File },
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
  ) => {
    const form = new FormData();
    form.append('purpose', input.purpose);
    if (input.targetId) form.append('targetId', input.targetId);
    form.append('file', input.file);
    return apiClient.upload<StoredFile>(base(companyId), form, options);
  },

  get: (companyId: string, fileId: string, signal?: AbortSignal) =>
    apiClient.get<StoredFile>(`${base(companyId)}/${fileId}`, { signal }),

  remove: (companyId: string, fileId: string) =>
    apiClient.delete<{ removed: true; deleted: boolean }>(`${base(companyId)}/${fileId}`),

  /** A public image's URL, built locally — no request needed. */
  publicUrl: (fileId: string | null | undefined) => apiClient.publicFileUrl(fileId),
};
