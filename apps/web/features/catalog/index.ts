/**
 * The catalog feature's public surface.
 *
 * Everything outside this slice imports from here and nowhere else — reaching
 * into `ui/` or `api/` couples callers to internals (`features/README.md`).
 */
export {
  catalogKeys,
  useServiceCategories,
  useCategoryTree,
  useCreateCategory,
  useUpdateCategory,
  useDeleteCategory,
  useServices,
  useService,
  useCreateService,
  useUpdateService,
  useDeleteService,
  useServiceAssignments,
} from './api/use-catalog';

export { ServiceList } from './ui/service-list';
export { ServiceForm } from './ui/service-form';
export { ServiceAssignments } from './ui/service-assignments';
export { CategoryManager } from './ui/category-manager';
