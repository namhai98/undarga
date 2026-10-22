# File & Media Storage

Upload, validation, storage and serving of the images attached to company
records. It reuses the existing `file` table and the image columns that
already existed (`company_branding.logo_file_id`,
`employee_profile.avatar_file_id`). It adds three more:

- `branch.image_file_id`
- `service.image_file_id`
- `company_customer.photo_file_id`

## 1. What can be uploaded

| Purpose | Attached to | Visibility | Permission to change | Permission to view | Minimum size | Stored at most |
|---|---|---|---|---|---|---|
| `COMPANY_LOGO` | company branding | public | `settings:branding:write` | `company:read` | 32 px | 1024 px |
| `BRANCH_IMAGE` | branch | public | `branch:write` | `branch:read` | 200 px | 1600 px |
| `EMPLOYEE_PHOTO` | employee profile | public | `employee:write` | `employee:read` | 96 px | 1024 px |
| `SERVICE_IMAGE` | service | public | `service:write` | `service:read` | 200 px | 1600 px |
| `CUSTOMER_PHOTO` | customer | **private** | `customer:write` | `customer:read` | 96 px | 1024 px |

- **Formats:** JPEG, PNG and WebP only. SVG (a scriptable document), GIF and
  HEIC are refused.
- **Public images** appear on the public booking page by design.
- **Customer photos** are only ever served to staff through a short-lived
  signed URL.
- There is no general-purpose file upload. Invoice PDFs keep using
  `file` (`invoice.pdf_file_id`), and cleanup respects them.

## 2. API

| Method and path | What |
|---|---|
| `POST /api/v1/companies/:companyId/files` | `multipart/form-data` with `file`, `purpose` and `targetId` (omit `targetId` for the logo). Uploads **and attaches**, replacing the previous image |
| `GET /api/v1/companies/:companyId/files/:fileId` | Metadata, and a `url`: the public URL, or a signed URL plus `urlExpiresAt` for a private file |
| `DELETE /api/v1/companies/:companyId/files/:fileId` | Detaches it from its record and deletes it, unless something else still uses it |
| `GET /api/v1/public/files/:fileId` | Serves a **public** image to anyone. Cached as immutable (a new image gets a new id), supports ETag and 304, and redirects to a CDN if `STORAGE_PUBLIC_BASE_URL` is set |
| `GET /api/v1/files/signed/:token` | Local driver only: a signed, expiring download of a private file |

- **Image ids in existing responses:** `imageFileId` on branches and services,
  `avatarFileId` on employees, `logoFileId` in branding, and `photoFileId` on
  customers. The public booking catalog includes the public ones.
- **Permissions:** checked per purpose, after authentication and tenant
  checks, before any of the body is read.
- **Other companies:** another company's file or record returns 404.
- **Error codes:**
  - `FILE_TOO_LARGE` (413)
  - `FILE_TYPE_NOT_ALLOWED` (415)
  - `FILE_INVALID` (422: not a valid image, or dimensions out of range)
  - `STORAGE_UNAVAILABLE` (503: nothing was saved)

## 3. Validation (nothing the client says is trusted)

1. **Streaming to disk.** The upload goes straight to a temp file under a
   random server-chosen name. It is cut off as soon as it passes
   `FILE_MAX_IMAGE_BYTES`, and deleted when the request ends.
2. **Claims.** The claimed MIME type must be an allowed image type, and
   executable or script file names (`.exe`, `.php`, `.svg`, `.html`…) are
   refused outright.
3. **Magic bytes.** The first bytes must be JPEG, PNG or WebP. The format is
   decided here, not by the name or the claimed type.
4. **Decoding.** libvips (`sharp`) must decode the file as that same format,
   with `failOn: 'error'`. Images over `FILE_MAX_IMAGE_PIXELS` are refused
   before decoding, which blocks decompression bombs. Dimensions must fall
   within the purpose's limits.
5. **Re-encoding.**
   - EXIF orientation is applied, then **all metadata is dropped**: camera,
     author, **GPS location** and comments.
   - The image is scaled down to the purpose's maximum.
   - What is stored is pixels this server wrote, so a polyglot file (an image
     that is also a script or an archive) does not survive.
6. **Storage key.** It is generated, never derived from input:
   `{public|private}/{companyId}/{purpose}/{uuid}.{ext}`. It is checked
   against a strict pattern before reaching disk or a bucket, and by a CHECK
   constraint in the database. Path traversal is impossible by construction.

All of this runs file-to-file. The image is never held in a JavaScript buffer.

## 4. Consistency: no orphans, no premature deletes

Each upload goes through these steps:

1. A `file` row is written as `UPLOADING`.
2. The bytes are streamed to storage. If that fails, the row is deleted and
   the API returns 503.
3. The record is pointed at the new file with a compare-and-set, and the row
   becomes `READY`. If that fails, the stored object and the row are deleted.
4. The image it replaced is deleted, **unless anything still references it**.
   The check covers branding (logo, favicon, email header), employee profiles,
   branches, services, customers and invoices.

`FileCleanupService` runs every `FILE_CLEANUP_INTERVAL_MS`:

1. It deletes `UPLOADING` rows older than `FILE_ORPHAN_GRACE_MINUTES` (a crash
   mid-upload).
2. It deletes `READY` files that nothing references and that are older than
   the grace period (for example, a record that used them was hard-deleted).
3. It removes the stored object of every deleted row not yet purged. If
   storage is down, it retries next time.

A file still in use is never removed. Rows are kept soft-deleted
(`deleted_at`, `purged_at`) as history.

## 5. Storage drivers

Only `StorageService` touches a backend. Controllers and business services go
through `FilesService`. Each file records which backend holds it
(`storage_provider`), so switching driver leaves existing files readable as
long as the old backend stays configured.

### Local (development)

- **Location:** `STORAGE_LOCAL_ROOT`, by default `var/uploads` under `apps/api`
  (git-ignored).
- **Writes:** written to a temporary name and then renamed, so there are no
  half-written files.
- **Private downloads:** signed API URLs (`/files/signed/:token`). The token is
  an HMAC derived from `JWT_ACCESS_SECRET`, covering the key, type, name and
  expiry. Tampering or expiry returns 404.
- **Limits:** suitable for a single API instance only, since each instance has
  its own disk. Production refuses it unless it is set deliberately.

### S3-compatible (production)

- **Stores:** AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, Backblaze B2.
- **Implementation:** a small SigV4 implementation over `fetch`, with no SDK.
  It is verified against AWS's published signature test vectors.
- **Uploads:** streamed with a known `Content-Length` (`UNSIGNED-PAYLOAD` over
  TLS).
- **Private files:** presigned GET URLs, valid for
  `FILE_SIGNED_URL_TTL_SECONDS` (5 minutes by default). The response type and
  a safe `Content-Disposition` are pinned into the signature.
- **Public images:** streamed through the API, or redirected to
  `STORAGE_PUBLIC_BASE_URL` (a CDN in front of the `public/` prefix), so the
  bucket itself can stay private.

**Headers on every served file:** `X-Content-Type-Options: nosniff`, a
sandboxing `Content-Security-Policy`, and the **detected** content type.
Private files also get `Cache-Control: no-store`.

## 6. Configuration

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_DRIVER` | `s3` when `S3_BUCKET` is set, else `local` | `local` or `s3` |
| `STORAGE_LOCAL_ROOT` | `var/uploads` | Local driver only |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | — | Required for `s3` |
| `S3_REGION` | `us-east-1` | Set it to the bucket's region (R2: `auto`) |
| `S3_ENDPOINT` | AWS | Set it for MinIO, R2, Spaces and similar |
| `S3_FORCE_PATH_STYLE` | `true` if `S3_ENDPOINT` is set | `endpoint/bucket/key` URLs |
| `STORAGE_PUBLIC_BASE_URL` | — | Optional CDN origin for public images |
| `API_PUBLIC_URL` | `http://localhost:PORT` | The API's public origin, used in the URLs it returns |
| `FILE_MAX_IMAGE_BYTES` | 5 MiB | Upload size limit |
| `FILE_MAX_IMAGE_PIXELS` | 40 000 000 | Limit against decompression bombs |
| `FILE_SIGNED_URL_TTL_SECONDS` | 300 | Lifetime of private download URLs |
| `FILE_CLEANUP_ENABLED`, `FILE_CLEANUP_INTERVAL_MS`, `FILE_ORPHAN_GRACE_MINUTES` | on, 10 min, 60 min | Cleanup sweep |

Credentials come only from the environment. They never appear in responses or
logs, and signed URLs are never logged.

### Deployment

1. Create a bucket with **all public access blocked**. If you use a CDN, give
   it read access to the `public/` prefix only. Use a dedicated key
   restricted to that bucket with `s3:PutObject`, `s3:GetObject` and
   `s3:DeleteObject`.
2. Set `STORAGE_DRIVER=s3`, the `S3_*` variables, and `API_PUBLIC_URL` (the
   public `https://` origin of the API).
3. Optionally put a CDN on the `public/` prefix and set
   `STORAGE_PUBLIC_BASE_URL`.
4. Make sure the API host has a writable temp directory. Uploads are spooled
   in `os.tmpdir()/undarga-uploads` and removed after each request.
5. Raise the reverse proxy's request body limit to at least
   `FILE_MAX_IMAGE_BYTES` plus 64 KB. For nginx that is `client_max_body_size`.

## 7. Frontend

- **`ImageUpload`** (`features/media`) handles file selection with a local
  preview, upload progress, client-side type and size checks (the server
  still decides), server error messages, retry after outages, cancel,
  replace and remove.
- **Where it is used:**
  - the service form (service image);
  - the staff list (staff photo);
  - customer details (private photo, viewed through a signed URL);
  - the new **Booking page images** screen (logo and branch pictures).
- **Public booking page:** shows the logo.

## 8. Tests

- **Unit tests** (`src/media/media.spec.ts`):
  - JPEG, PNG and WebP accepted by content;
  - downscaling;
  - EXIF and GPS stripped, and orientation applied;
  - SVG, EXE, GIF and HTML refused;
  - polyglot and mismatched content refused;
  - minimum and maximum dimensions, and pixel bombs;
  - claim and extension checks, and name sanitising;
  - safe storage keys and header injection;
  - local driver: storage, signed tokens (tampering, expiry, wrong secret)
    and root escape;
  - S3 signer: the AWS test vectors (header and presigned), URL styles,
    error mapping, and no secrets on the wire.
- **End to end** (`test/files.e2e-spec.ts`):
  - upload, attach and serve publicly (headers, 304);
  - logo, staff photo and service image;
  - replace (old file deleted from the table and storage);
  - remove versus detach-when-shared;
  - oversized files, wrong content, fake images and dimensions, leaving no
    temp files or rows behind;
  - missing fields;
  - anonymous and per-purpose RBAC, and cross-company access;
  - delete permissions;
  - private download via a signed URL (tampered tokens refused, never public);
  - storage failure, attach failure, and the cleanup sweep.
- **Web** (`features/media/ui/image-upload.test.tsx`): the component's
  states and actions.

## 9. Known limits

- **No virus scanning.** `file.scan_status` stays `PENDING`. Re-encoding
  neutralises active content in images, but a scanner (for example ClamAV)
  would be needed before accepting documents.
- **Concurrent uploads.** Two simultaneous uploads for the same record end
  with the later one attached. The other is unreferenced and removed by the
  sweep after the grace period, not immediately.
- **Customer erasure.** No anonymisation flow exists yet. When one is added,
  it should clear `photo_file_id`, and the sweep will then delete the photo.
