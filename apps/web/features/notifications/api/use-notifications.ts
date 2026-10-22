'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/features/auth';
import {
  notificationsService,
  type CustomerNotificationPreferences,
  type NotificationChannel,
  type NotificationQuery,
  type NotificationSettingsUpdate,
  type NotificationTemplate,
  type ProviderChannelView,
  type SaveProviderInput,
  type TemplateInput,
} from '@/services/notifications.service';

export const notificationKeys = {
  all: (companyId: string) => ['notifications', companyId] as const,
  list: (companyId: string, query: NotificationQuery) =>
    [...notificationKeys.all(companyId), 'list', query] as const,
  detail: (companyId: string, id: string) =>
    [...notificationKeys.all(companyId), 'detail', id] as const,
  stats: (companyId: string) => [...notificationKeys.all(companyId), 'stats'] as const,
  settings: (companyId: string) => [...notificationKeys.all(companyId), 'settings'] as const,
  templates: (companyId: string) => [...notificationKeys.all(companyId), 'templates'] as const,
  providers: (companyId: string) => [...notificationKeys.all(companyId), 'providers'] as const,
  customer: (companyId: string, customerId: string) =>
    [...notificationKeys.all(companyId), 'customer', customerId] as const,
};

export function useNotifications(query: NotificationQuery = {}) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.list(activeCompanyId ?? 'none', query),
    queryFn: ({ signal }) => notificationsService.list(activeCompanyId!, query, signal),
    enabled: Boolean(activeCompanyId),
    placeholderData: keepPreviousData,
  });
}

export function useNotification(notificationId: string | null) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.detail(activeCompanyId ?? 'none', notificationId ?? 'none'),
    queryFn: ({ signal }) => notificationsService.get(activeCompanyId!, notificationId!, signal),
    enabled: Boolean(activeCompanyId && notificationId),
  });
}

export function useNotificationStats() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.stats(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => notificationsService.stats(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

/** Process this company's queue now. The worker does it anyway; this is for the impatient. */
export function useRunNotifications() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => notificationsService.run(activeCompanyId!),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationKeys.all(activeCompanyId!) }),
  });
}

export function useNotificationSettings() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.settings(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => notificationsService.settings(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

export function useUpdateNotificationSettings() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: NotificationSettingsUpdate) =>
      notificationsService.updateSettings(activeCompanyId!, input),
    onSuccess: (saved) =>
      queryClient.setQueryData(notificationKeys.settings(activeCompanyId!), saved),
  });
}

export function useNotificationTemplates() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.templates(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => notificationsService.templates(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

/** Create when `id` is null, otherwise update. */
export function useSaveTemplate() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation<
    NotificationTemplate,
    unknown,
    { id: string | null; type: string; channel: NotificationChannel } & TemplateInput
  >({
    mutationFn: ({ id, type, channel, ...input }) =>
      id
        ? notificationsService.updateTemplate(activeCompanyId!, id, input)
        : notificationsService.createTemplate(activeCompanyId!, {
            type,
            channel,
            ...input,
            body: input.body ?? '',
          }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationKeys.templates(activeCompanyId!) }),
  });
}

/** A button press, so a mutation: a preview must never be served from cache. */
export function usePreviewTemplate() {
  const { activeCompanyId } = useSession();
  return useMutation({
    mutationFn: (input: {
      type: string;
      channel: NotificationChannel;
      subject?: string | null;
      body: string;
    }) => notificationsService.previewTemplate(activeCompanyId!, input),
  });
}

export function useCustomerNotificationPreferences(customerId: string, enabled = true) {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.customer(activeCompanyId ?? 'none', customerId),
    queryFn: ({ signal }) =>
      notificationsService.customerPreferences(activeCompanyId!, customerId, signal),
    enabled: Boolean(activeCompanyId) && enabled,
  });
}

export function useUpdateCustomerNotificationPreferences(customerId: string) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation<
    CustomerNotificationPreferences,
    unknown,
    Partial<CustomerNotificationPreferences['enabled']>
  >({
    mutationFn: (input) =>
      notificationsService.updateCustomerPreferences(activeCompanyId!, customerId, input),
    onSuccess: (saved) =>
      queryClient.setQueryData(notificationKeys.customer(activeCompanyId!, customerId), saved),
  });
}

/** Send a failed or unknown message again. Refreshes the history and stats. */
export function useRetryNotification() {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      notificationsService.retry(activeCompanyId!, notificationId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationKeys.all(activeCompanyId!) }),
  });
}

export function useNotificationProviders() {
  const { activeCompanyId } = useSession();
  return useQuery({
    queryKey: notificationKeys.providers(activeCompanyId ?? 'none'),
    queryFn: ({ signal }) => notificationsService.providers(activeCompanyId!, signal),
    enabled: Boolean(activeCompanyId),
  });
}

function useProviderMutation<TInput>(
  call: (companyId: string, input: TInput) => Promise<ProviderChannelView>,
) {
  const { activeCompanyId } = useSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => call(activeCompanyId!, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: notificationKeys.providers(activeCompanyId!) }),
  });
}

export function useSaveNotificationProvider() {
  return useProviderMutation(
    (companyId, input: { channel: 'EMAIL' | 'SMS'; config: SaveProviderInput }) =>
      notificationsService.saveProvider(companyId, input.channel, input.config),
  );
}

export function useRemoveNotificationProvider() {
  return useProviderMutation((companyId, channel: 'EMAIL' | 'SMS') =>
    notificationsService.removeProvider(companyId, channel),
  );
}

export function useVerifyNotificationProvider() {
  return useProviderMutation((companyId, channel: 'EMAIL' | 'SMS') =>
    notificationsService.verifyProvider(companyId, channel),
  );
}
