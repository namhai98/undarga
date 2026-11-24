/**
 * Booking rules: notice, booking window, cancellation and rescheduling
 * deadlines, customer self-service. Enforced by the server on every path.
 */
export {
  bookingSettingsKeys,
  useBookingSettings,
  useUpdateBookingSettings,
} from './api/use-booking-settings';
export { BookingSettingsPage } from './ui/booking-settings-page';
