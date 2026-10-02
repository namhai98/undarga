'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCan } from '@/features/auth';
import { useZodForm } from '@/hooks/use-zod-form';
import { ApiError } from '@/services/api-error';
import type { ServiceCategory } from '@/services/catalog.service';
import {
  useCategoryTree,
  useCreateCategory,
  useDeleteCategory,
  useServiceCategories,
  useUpdateCategory,
} from '../api/use-catalog';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Give the category a name.').max(96),
  parentId: z.string(),
  sortOrder: z.coerce.number().int().min(0).max(32767),
});

const selectClass =
  'border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-8 rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-3';

/**
 * How the catalogue is grouped.
 *
 * ---------------------------------------------------------------------------
 * TWO LEVELS, AND ONLY TOP-LEVEL CATEGORIES CAN BE PARENTS
 * ---------------------------------------------------------------------------
 *
 * The API caps nesting at two, so the parent picker offers only roots. Names
 * are unique per PARENT rather than per company, which is the point of the
 * hierarchy: `Hair > Colouring` and `Nails > Colouring` can both exist.
 *
 * Deleting is refused while a category still holds services or sub-categories,
 * and the refusal carries the count — so the message says how much work moving
 * them is, rather than just "cannot delete".
 */
export function CategoryManager() {
  const canWrite = useCan('service:write');
  const categories = useServiceCategories();
  const tree = useCategoryTree();

  const [editing, setEditing] = useState<ServiceCategory | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = useDeleteCategory();

  const handleDelete = async (category: ServiceCategory) => {
    setError(null);
    try {
      await remove.mutateAsync(category.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : `Could not delete “${category.name}”.`,
      );
    }
  };

  return (
    <section className="grid max-w-2xl gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-lg font-semibold">Service categories</h2>
          <p className="text-muted-foreground text-sm">
            How the booking page groups what you sell. Two levels deep.
          </p>
        </div>
        {canWrite ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            Add category
          </Button>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not delete</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {editing ? (
        <CategoryForm
          category={editing === 'new' ? null : editing}
          roots={tree}
          onDone={() => setEditing(null)}
        />
      ) : null}

      {categories.isPending ? (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading categories…</span>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {!categories.isPending && tree.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No categories yet</p>
          <p className="text-muted-foreground mt-1 text-sm">
            Services work without one; categories only decide how they are grouped.
          </p>
        </div>
      ) : null}

      {tree.length > 0 ? (
        <ul className="grid gap-2">
          {tree.map((parent) => (
            <li key={parent.id} className="border-border/60 rounded-lg border">
              <CategoryRow
                category={parent}
                canWrite={canWrite}
                onEdit={() => setEditing(parent)}
                onDelete={() => void handleDelete(parent)}
                deleting={remove.isPending}
              />
              {parent.children.length > 0 ? (
                <ul className="border-border/60 border-t">
                  {parent.children.map((child) => (
                    <li key={child.id} className="border-border/40 border-b last:border-0">
                      <CategoryRow
                        category={child}
                        nested
                        canWrite={canWrite}
                        onEdit={() => setEditing(child)}
                        onDelete={() => void handleDelete(child)}
                        deleting={remove.isPending}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CategoryRow({
  category,
  nested,
  canWrite,
  onEdit,
  onDelete,
  deleting,
}: {
  category: ServiceCategory;
  nested?: boolean;
  canWrite: boolean;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-2 text-sm ${nested ? 'pl-8' : ''}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        {category.color ? (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: category.color }}
          />
        ) : null}
        <span className="truncate font-medium">{category.name}</span>
        {/* The count is what makes the delete button honest. */}
        <Badge variant="secondary">
          {category.serviceCount} {category.serviceCount === 1 ? 'service' : 'services'}
        </Badge>
      </span>

      {canWrite ? (
        <span className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            disabled={deleting}
            onClick={onDelete}
          >
            Delete
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function CategoryForm({
  category,
  roots,
  onDone,
}: {
  category: ServiceCategory | null;
  roots: ServiceCategory[];
  onDone: () => void;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const { errors, onSubmit, applyServerErrors } = useZodForm(formSchema);

  const create = useCreateCategory();
  const update = useUpdateCategory();
  const pending = create.isPending || update.isPending;

  /**
   * A category cannot be its own parent, and one that already has children
   * cannot itself be nested — the API refuses both, and offering them here
   * would only produce an error the user could have been spared.
   */
  const parentOptions = roots.filter((root) => root.id !== category?.id);

  const handle = onSubmit(async (values) => {
    setFormError(null);
    const input = {
      name: values.name,
      parentId: values.parentId || null,
      sortOrder: values.sortOrder,
    };

    try {
      if (category) {
        await update.mutateAsync({ categoryId: category.id, input });
      } else {
        await create.mutateAsync(input);
      }
      onDone();
    } catch (error) {
      if (applyServerErrors(error)) return;
      setFormError(
        error instanceof ApiError ? error.message : 'Could not save the category.',
      );
    }
  });

  return (
    <form
      onSubmit={handle}
      className="border-border/60 grid gap-4 rounded-lg border p-4"
      noValidate
    >
      <h3 className="text-sm font-medium">{category ? 'Edit category' : 'New category'}</h3>

      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
        <div className="grid gap-1.5">
          <Label htmlFor="category-name">Name</Label>
          <Input
            id="category-name"
            name="name"
            defaultValue={category?.name ?? ''}
            required
            maxLength={96}
          />
          {errors.name ? (
            <p role="alert" className="text-destructive text-xs">
              {errors.name}
            </p>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="category-parent">Parent</Label>
          <select
            id="category-parent"
            name="parentId"
            defaultValue={category?.parentId ?? ''}
            className={selectClass}
          >
            <option value="">Top level</option>
            {parentOptions.map((root) => (
              <option key={root.id} value={root.id}>
                {root.name}
              </option>
            ))}
          </select>
          {errors.parentId ? (
            <p role="alert" className="text-destructive text-xs">
              {errors.parentId}
            </p>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="category-sort">Order</Label>
          <Input
            id="category-sort"
            name="sortOrder"
            type="number"
            inputMode="numeric"
            min={0}
            max={32767}
            step={1}
            defaultValue={category?.sortOrder ?? 0}
            className="w-20"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {category ? 'Save' : 'Create'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
