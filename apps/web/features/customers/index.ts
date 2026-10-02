/**
 * The customers feature's public surface.
 *
 * Everything outside this slice imports from here and nowhere else — reaching
 * into `ui/` or `api/` couples callers to internals (`features/README.md`).
 */
export {
  customerKeys,
  useCustomers,
  useCustomer,
  useCustomerAppointments,
  useCreateCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
} from './api/use-customers';

export { CustomerList } from './ui/customer-list';
export { CustomerForm } from './ui/customer-form';
export { CustomerDetail } from './ui/customer-detail';
