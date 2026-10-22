'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan, useSession } from '@/features/auth';
import { branchKeys, useBranches } from '@/features/branches';
import { companyKeys, useCompanyBranding } from '@/features/companies';
import { ImageUpload } from './image-upload';

/**
 * The pictures on the public booking page that belong to the company itself:
 * its logo and a picture per branch. Staff photos and service images are on
 * the staff and service screens, next to the rest of those records.
 *
 * Logo: `settings:branding:write`. Branch pictures: `branch:write`. Anyone
 * who can see the company sees the current images; the controls appear only
 * with the permission, and the API enforces it regardless.
 */
export function BookingPageImages() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  const canBranding = useCan('settings:branding:write');
  const canBranch = useCan('branch:write');
  const branding = useCompanyBranding();
  const branches = useBranches();

  const refresh = (key: readonly unknown[]) =>
    void queryClient.invalidateQueries({ queryKey: key });

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-xl font-semibold">Booking page images</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Your logo and branch pictures, as customers see them when booking. Images are checked,
          resized and stripped of hidden data (such as location) when uploaded.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>Square works best. At least 32 × 32 pixels.</CardDescription>
        </CardHeader>
        <CardContent>
          {branding.isPending ? (
            <Skeleton className="h-28 w-28" />
          ) : branding.error ? (
            <LoadError what="the logo" />
          ) : (
            <ImageUpload
              purpose="COMPANY_LOGO"
              fileId={branding.data?.logoFileId ?? null}
              label="Company logo"
              canEdit={canBranding}
              onChange={() => activeCompanyId && refresh(companyKeys.branding(activeCompanyId))}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branches</CardTitle>
          <CardDescription>One picture per branch, at least 200 × 200 pixels.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {branches.isPending ? <Skeleton className="h-28 w-full" /> : null}
          {branches.error ? <LoadError what="the branches" /> : null}
          {branches.data?.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">No branches yet.</p>
          ) : null}
          {branches.data?.items.map((branch) => (
            <ImageUpload
              key={branch.id}
              purpose="BRANCH_IMAGE"
              targetId={branch.id}
              fileId={branch.imageFileId}
              label={branch.name}
              shape="wide"
              canEdit={canBranch}
              onChange={() => activeCompanyId && refresh(branchKeys.all(activeCompanyId))}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function LoadError({ what }: { what: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>Could not load {what}</AlertTitle>
      <AlertDescription>Please try again.</AlertDescription>
    </Alert>
  );
}
