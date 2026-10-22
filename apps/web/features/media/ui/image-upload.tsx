'use client';

import { useQuery } from '@tanstack/react-query';
import { ImageIcon, Loader2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useSession } from '@/features/auth';
import { ApiAbortError, ApiError } from '@/services/api-error';
import {
  ACCEPTED_IMAGE_TYPES,
  DEFAULT_MAX_IMAGE_BYTES,
  filesService,
  type FilePurpose,
  type StoredFile,
} from '@/services/files.service';

export interface ImageUploadProps {
  purpose: FilePurpose;
  /** The record it belongs to. Not needed for the company logo. */
  targetId?: string;
  /** The image in use now, if any. */
  fileId: string | null;
  label: string;
  hint?: string;
  /** Private images (customer photos) are shown through a short-lived signed URL. */
  visibility?: 'PUBLIC' | 'PRIVATE';
  /** Without it the image is shown but cannot be changed. */
  canEdit: boolean;
  shape?: 'square' | 'wide' | 'round';
  maxBytes?: number;
  /** After a successful upload (the new file) or removal (null). */
  onChange?: (file: StoredFile | null) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; progress: number }
  | { kind: 'failed'; message: string; canRetry: boolean };

const SHAPE: Record<NonNullable<ImageUploadProps['shape']>, string> = {
  square: 'aspect-square w-28',
  round: 'aspect-square w-24 rounded-full',
  wide: 'aspect-[16/9] w-full max-w-xs',
};

/**
 * One image on one record: show it, upload a replacement, remove it.
 *
 * The browser checks type and size first only to save a pointless upload; the
 * server judges the actual content, dimensions and permission, and its answer
 * is what is shown. The preview of a picked file is a local object URL, so it
 * appears instantly and nothing is sent until the upload starts.
 */
export function ImageUpload({
  purpose,
  targetId,
  fileId,
  label,
  hint,
  visibility = 'PUBLIC',
  canEdit,
  shape = 'square',
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  onChange,
}: ImageUploadProps) {
  const { activeCompanyId } = useSession();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [picked, setPicked] = useState<{ file: File; preview: string } | null>(null);
  const [removing, setRemoving] = useState(false);

  // A private image needs a signed URL; a public one is a plain address.
  const signed = useQuery({
    queryKey: ['file-url', activeCompanyId, fileId],
    queryFn: ({ signal }) => filesService.get(activeCompanyId!, fileId!, signal),
    enabled: visibility === 'PRIVATE' && Boolean(activeCompanyId && fileId),
    // Refresh before the signed URL expires.
    staleTime: 4 * 60_000,
  });
  const currentUrl =
    visibility === 'PRIVATE' ? (signed.data?.url ?? null) : filesService.publicUrl(fileId);

  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked.preview);
    },
    [picked],
  );

  const send = async (file: File) => {
    if (!activeCompanyId) return;
    abort.current = new AbortController();
    setPhase({ kind: 'uploading', progress: 0 });
    try {
      const stored = await filesService.upload(
        activeCompanyId,
        { purpose, targetId, file },
        {
          signal: abort.current.signal,
          onProgress: (progress) => setPhase({ kind: 'uploading', progress }),
        },
      );
      setPhase({ kind: 'idle' });
      setPicked(null);
      onChange?.(stored);
    } catch (error) {
      setPhase(failure(error));
    } finally {
      abort.current = null;
    }
  };

  const choose = (file: File | undefined) => {
    if (!file) return;
    if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(file.type)) {
      setPhase({ kind: 'failed', message: 'Use a JPEG, PNG or WebP image.', canRetry: false });
      return;
    }
    if (file.size > maxBytes) {
      setPhase({
        kind: 'failed',
        message: `The image is larger than ${megabytes(maxBytes)}.`,
        canRetry: false,
      });
      return;
    }
    setPicked({ file, preview: URL.createObjectURL(file) });
    void send(file);
  };

  const remove = async () => {
    if (!activeCompanyId || !fileId) return;
    setRemoving(true);
    setPhase({ kind: 'idle' });
    try {
      await filesService.remove(activeCompanyId, fileId);
      onChange?.(null);
    } catch (error) {
      setPhase(failure(error, 'Could not remove the image.'));
    } finally {
      setRemoving(false);
    }
  };

  const shown = picked?.preview ?? currentUrl;
  const uploading = phase.kind === 'uploading';

  return (
    <div className="grid gap-2" role="group" aria-labelledby={`${inputId}-label`}>
      <span id={`${inputId}-label`} className="text-sm font-medium">
        {label}
      </span>
      <div className="flex flex-wrap items-start gap-4">
        <div
          className={`bg-muted/40 border-border/60 relative grid shrink-0 place-items-center overflow-hidden rounded-lg border ${SHAPE[shape]}`}
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- API-served, already sized server-side
            <img
              src={shown}
              alt={picked ? `${label} preview` : label}
              className="h-full w-full object-cover"
            />
          ) : (
            <ImageIcon className="text-muted-foreground size-6" aria-hidden />
          )}
          {uploading ? (
            <div className="bg-background/70 absolute inset-0 grid place-items-center">
              <Loader2 className="animate-spin" aria-hidden />
            </div>
          ) : null}
        </div>

        <div className="grid min-w-0 flex-1 gap-2">
          {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
          {canEdit ? (
            <>
              <input
                ref={input}
                id={inputId}
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                className="sr-only"
                aria-label={`Choose ${label.toLowerCase()}`}
                disabled={uploading || removing}
                onChange={(e) => {
                  choose(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={uploading || removing}
                  onClick={() => input.current?.click()}
                >
                  {fileId ? 'Replace' : 'Upload'}
                </Button>
                {fileId && !uploading ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={removing}
                    onClick={() => void remove()}
                  >
                    {removing ? <Loader2 className="animate-spin" aria-hidden /> : null}
                    Remove
                  </Button>
                ) : null}
                {uploading ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => abort.current?.abort()}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}

          {uploading ? (
            <div className="grid gap-1">
              <div
                role="progressbar"
                aria-label={`Uploading ${label.toLowerCase()}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(phase.progress * 100)}
                className="bg-muted h-1.5 w-full max-w-xs overflow-hidden rounded-full"
              >
                <div
                  className="bg-primary h-full transition-[width]"
                  style={{ width: `${Math.round(phase.progress * 100)}%` }}
                />
              </div>
              <span className="text-muted-foreground text-xs">
                {Math.round(phase.progress * 100)}%
              </span>
            </div>
          ) : null}

          {phase.kind === 'failed' ? (
            <div className="grid gap-1">
              <p role="alert" className="text-destructive text-sm">
                {phase.message}
              </p>
              {phase.canRetry && picked ? (
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void send(picked.file)}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function failure(error: unknown, fallback = 'The upload failed.'): Phase {
  if (error instanceof ApiAbortError)
    return { kind: 'failed', message: 'Upload cancelled.', canRetry: true };
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'FILE_TOO_LARGE':
      case 'FILE_TYPE_NOT_ALLOWED':
      case 'FILE_INVALID':
        return { kind: 'failed', message: error.message, canRetry: false };
      case 'PERMISSION_DENIED':
        return {
          kind: 'failed',
          message: 'You do not have permission to change this image.',
          canRetry: false,
        };
      case 'STORAGE_UNAVAILABLE':
        return { kind: 'failed', message: error.message, canRetry: true };
      default:
        return {
          kind: 'failed',
          message: error.status >= 500 ? fallback : error.message,
          canRetry: error.status >= 500,
        };
    }
  }
  // Network failure: worth another go.
  return { kind: 'failed', message: `${fallback} Check your connection.`, canRetry: true };
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
