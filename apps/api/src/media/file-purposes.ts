import { COMPANY_PERMISSIONS } from '../authz/permissions';
import type { TenantTx } from '../database/tenant-prisma.service';
import type { ImageRules } from './image-processing';

export const FILE_PURPOSES = [
  'COMPANY_LOGO',
  'BRANCH_IMAGE',
  'EMPLOYEE_PHOTO',
  'SERVICE_IMAGE',
  'CUSTOMER_PHOTO',
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
export type FileVisibility = 'PUBLIC' | 'PRIVATE';

/**
 * Where a purpose's file is referenced from: read the current file id, and
 * swap it — compare-and-set, so two concurrent uploads cannot both believe
 * they replaced the same image.
 */
interface TargetSlot {
  /** The file id in use now; throws NOT FOUND when the target does not exist. */
  current(tx: TenantTx, companyId: string, targetId: string): Promise<string | null | undefined>;
  /** Point the target at `next` only if it still points at `expected`. */
  swap(
    tx: TenantTx,
    companyId: string,
    targetId: string,
    expected: string | null,
    next: string | null,
  ): Promise<boolean>;
  /** The resource name for 404s. */
  resource: string;
}

export interface PurposeDefinition {
  label: string;
  visibility: FileVisibility;
  /** Needed to upload, replace or remove. */
  write: string;
  /** Needed to read the metadata / a signed URL. */
  read: string;
  /** The target is the company itself: no `targetId` from the client. */
  targetIsCompany: boolean;
  rules: Omit<ImageRules, 'maxPixels'>;
  slot: TargetSlot;
}

const C = COMPANY_PERMISSIONS;

/**
 * Every kind of upload this product accepts, and the rules for each. Nothing
 * else can be uploaded: there is no general-purpose file drop.
 *
 * Booking-page images (logo, branch, staff portrait, service) are PUBLIC by
 * intent — they are on the public booking page. A customer's photo is
 * PRIVATE: staff with `customer:read` see it through a signed URL that
 * expires in minutes, and it is never on a public page.
 */
export const PURPOSES: Readonly<Record<FilePurpose, PurposeDefinition>> = {
  COMPANY_LOGO: {
    label: 'Company logo',
    visibility: 'PUBLIC',
    write: C.BRANDING_WRITE,
    read: C.COMPANY_READ,
    targetIsCompany: true,
    rules: { minEdge: 32, maxEdge: 8000, maxOutputEdge: 1024 },
    slot: {
      resource: 'Company',
      async current(tx, companyId) {
        const company = await tx.company.findFirst({
          where: { id: companyId },
          select: { id: true },
        });
        if (!company) return undefined;
        const branding = await tx.companyBranding.findFirst({
          where: { companyId },
          select: { logoFileId: true },
        });
        return branding?.logoFileId ?? null;
      },
      async swap(tx, companyId, _targetId, expected, next) {
        const { count } = await tx.companyBranding.updateMany({
          where: { companyId, logoFileId: expected },
          data: { logoFileId: next },
        });
        if (count === 1) return true;
        // No branding row yet: it is optional, so create it.
        if (expected === null && !(await tx.companyBranding.findFirst({ where: { companyId } }))) {
          await tx.companyBranding.create({ data: { companyId, logoFileId: next } });
          return true;
        }
        return false;
      },
    },
  },
  BRANCH_IMAGE: {
    label: 'Branch image',
    visibility: 'PUBLIC',
    write: C.BRANCH_WRITE,
    read: C.BRANCH_READ,
    targetIsCompany: false,
    rules: { minEdge: 200, maxEdge: 8000, maxOutputEdge: 1600 },
    slot: {
      resource: 'Branch',
      async current(tx, companyId, id) {
        const row = await tx.branch.findFirst({
          where: { id, companyId, deletedAt: null },
          select: { imageFileId: true },
        });
        return row ? row.imageFileId : undefined;
      },
      async swap(tx, companyId, id, expected, next) {
        const { count } = await tx.branch.updateMany({
          where: { id, companyId, deletedAt: null, imageFileId: expected },
          data: { imageFileId: next },
        });
        return count === 1;
      },
    },
  },
  EMPLOYEE_PHOTO: {
    label: 'Staff photo',
    visibility: 'PUBLIC',
    write: C.EMPLOYEE_WRITE,
    read: C.EMPLOYEE_READ,
    targetIsCompany: false,
    rules: { minEdge: 96, maxEdge: 8000, maxOutputEdge: 1024 },
    slot: {
      resource: 'Employee',
      async current(tx, companyId, id) {
        const row = await tx.employee.findFirst({
          where: { id, companyId, deletedAt: null },
          select: { profile: { select: { avatarFileId: true } } },
        });
        return row ? (row.profile?.avatarFileId ?? null) : undefined;
      },
      async swap(tx, companyId, id, expected, next) {
        const { count } = await tx.employeeProfile.updateMany({
          where: { companyId, employeeId: id, avatarFileId: expected },
          data: { avatarFileId: next },
        });
        if (count === 1) return true;
        if (
          expected === null &&
          !(await tx.employeeProfile.findFirst({ where: { companyId, employeeId: id } }))
        ) {
          await tx.employeeProfile.create({
            data: { companyId, employeeId: id, avatarFileId: next },
          });
          return true;
        }
        return false;
      },
    },
  },
  SERVICE_IMAGE: {
    label: 'Service image',
    visibility: 'PUBLIC',
    write: C.SERVICE_WRITE,
    read: C.SERVICE_READ,
    targetIsCompany: false,
    rules: { minEdge: 200, maxEdge: 8000, maxOutputEdge: 1600 },
    slot: {
      resource: 'Service',
      async current(tx, companyId, id) {
        const row = await tx.service.findFirst({
          where: { id, companyId, deletedAt: null },
          select: { imageFileId: true },
        });
        return row ? row.imageFileId : undefined;
      },
      async swap(tx, companyId, id, expected, next) {
        const { count } = await tx.service.updateMany({
          where: { id, companyId, deletedAt: null, imageFileId: expected },
          data: { imageFileId: next },
        });
        return count === 1;
      },
    },
  },
  CUSTOMER_PHOTO: {
    label: 'Customer photo',
    visibility: 'PRIVATE',
    write: C.CUSTOMER_WRITE,
    read: C.CUSTOMER_READ,
    targetIsCompany: false,
    rules: { minEdge: 96, maxEdge: 8000, maxOutputEdge: 1024 },
    slot: {
      resource: 'Customer',
      async current(tx, companyId, id) {
        const row = await tx.companyCustomer.findFirst({
          where: { id, companyId, deletedAt: null },
          select: { photoFileId: true },
        });
        return row ? row.photoFileId : undefined;
      },
      async swap(tx, companyId, id, expected, next) {
        const { count } = await tx.companyCustomer.updateMany({
          where: { id, companyId, deletedAt: null, photoFileId: expected },
          data: { photoFileId: next },
        });
        return count === 1;
      },
    },
  },
};

export function isFilePurpose(value: string): value is FilePurpose {
  return (FILE_PURPOSES as readonly string[]).includes(value);
}

/**
 * Whether anything still points at a file. Checked before a file is deleted,
 * so an image in use elsewhere is never removed.
 */
export async function isReferenced(
  tx: TenantTx,
  companyId: string,
  fileId: string,
): Promise<boolean> {
  const counts = await Promise.all([
    tx.companyBranding.count({
      where: {
        companyId,
        OR: [{ logoFileId: fileId }, { faviconFileId: fileId }, { emailHeaderFileId: fileId }],
      },
    }),
    tx.employeeProfile.count({ where: { companyId, avatarFileId: fileId } }),
    tx.branch.count({ where: { companyId, imageFileId: fileId } }),
    tx.service.count({ where: { companyId, imageFileId: fileId } }),
    tx.companyCustomer.count({ where: { companyId, photoFileId: fileId } }),
    tx.invoice.count({ where: { companyId, pdfFileId: fileId } }),
  ]);
  return counts.some((n) => n > 0);
}
