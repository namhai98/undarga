/**
 * The subscription feature's public surface: the company's plan, usage, plan
 * comparison and billing history, plus the read-only banner for the shell.
 *
 * Nothing here takes a payment. Invoices are issued by the server and settled
 * outside the app until a payment provider is integrated.
 */
export {
  subscriptionKeys,
  useSubscription,
  useInvoices,
  useSubscriptionAction,
} from './api/use-subscription';

export { SubscriptionPage } from './ui/subscription-page';
export { ReadOnlyBanner } from './ui/read-only-banner';
