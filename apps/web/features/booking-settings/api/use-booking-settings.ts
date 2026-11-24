'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  bookingSettingsService,
  type UpdateBookingSettingsInput,
} from '@/services/booking-settings.service';

export const bookingSettingsKeys = {
  detail: (companyId: string) => ['booking-settings', companyId] as const,
};

export function useBookingSettings() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: bookingSettingsKeys.detail(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => bookingSettingsService.get(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useUpdateBookingSettings() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateBookingSettingsInput) =>
      bookingSettingsService.update(activeCompanyId!, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(bookingSettingsKeys.detail(activeCompanyId!), saved);
      // The rules change which slots exist.
      void queryClient.invalidateQueries({ queryKey: ['availability', activeCompanyId] });
    },
  });
}
