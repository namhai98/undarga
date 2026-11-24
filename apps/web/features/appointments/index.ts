/**
 * The appointments feature's public surface.
 *
 * Everything outside this slice imports from here and nowhere else
 * (`features/README.md`).
 */
export {
  appointmentKeys,
  useAppointments,
  useAppointment,
  useCreateAppointment,
  useAppointmentAction,
  useCancelAppointment,
  useRescheduleAppointment,
  usePreviewSeries,
  useCreateSeries,
  useSeries,
  useCancelSeries,
} from './api/use-appointments';

export { AppointmentList } from './ui/appointment-list';
export { AppointmentDetail } from './ui/appointment-detail';
export { BookingWizard } from './ui/booking-wizard';
export { SlotPicker } from './ui/slot-picker';
export { StatusBadge } from './ui/status-badge';
export { bookingErrorMessage } from './model/appointment-display';
