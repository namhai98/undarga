import { apiClient } from './api-client';

export type ResourceKind =
  | 'ROOM'
  | 'CHAIR'
  | 'EQUIPMENT'
  | 'MEETING_ROOM'
  | 'TREATMENT_ROOM'
  | 'SERVICE_BAY'
  | 'OTHER';

export type ResourceStatus = 'ACTIVE' | 'OUT_OF_SERVICE' | 'INACTIVE';

export interface ResourceType {
  id: string;
  key: string;
  name: string;
  kind: ResourceKind;
  description: string | null;
}

export interface Resource {
  id: string;
  branchId: string;
  resourceTypeId: string;
  resourceTypeName: string;
  kind: ResourceKind;
  name: string;
  code: string | null;
  status: ResourceStatus;
  isBookable: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A weekly window, branch-local `HH:MM`. 0 = Sunday. */
export interface ResourceWindow {
  dayOfWeek: number;
  startsAt: string;
  endsAt: string;
}

export type UnavailabilityReason = 'MAINTENANCE' | 'OUT_OF_SERVICE' | 'RESERVED' | 'OTHER';

export interface ResourceUnavailability {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: UnavailabilityReason;
  note: string | null;
  createdAt: string;
}

/**
 * Rooms, chairs and equipment. Each is booked by one appointment at a time;
 * capacity is several resources of one type.
 */
export const resourcesService = {
  types: (companyId: string, signal?: AbortSignal) =>
    apiClient.get<ResourceType[]>(`/companies/${companyId}/resource-types`, { signal }),

  createType: (
    companyId: string,
    input: { key: string; name: string; kind: ResourceKind; description?: string | null },
  ) => apiClient.post<ResourceType>(`/companies/${companyId}/resource-types`, input),

  list: (companyId: string, query: { branchId?: string } = {}, signal?: AbortSignal) =>
    apiClient.get<{ items: Resource[]; total: number }>(`/companies/${companyId}/resources`, {
      query: { ...query },
      signal,
    }),

  create: (
    companyId: string,
    input: { branchId: string; resourceTypeId: string; name: string; code?: string | null },
  ) => apiClient.post<Resource>(`/companies/${companyId}/resources`, input),

  update: (
    companyId: string,
    id: string,
    input: Partial<Pick<Resource, 'name' | 'code' | 'status' | 'isBookable' | 'notes'>>,
  ) => apiClient.patch<Resource>(`/companies/${companyId}/resources/${id}`, input),

  remove: (companyId: string, id: string) =>
    apiClient.delete<{ deleted: true }>(`/companies/${companyId}/resources/${id}`),

  availability: (companyId: string, id: string, signal?: AbortSignal) =>
    apiClient.get<{ rules: ResourceWindow[] }>(
      `/companies/${companyId}/resources/${id}/availability`,
      { signal },
    ),

  /** Replaces every window. `[]` = follow the branch's opening hours. */
  putAvailability: (companyId: string, id: string, rules: ResourceWindow[]) =>
    apiClient.put<{ rules: ResourceWindow[] }>(
      `/companies/${companyId}/resources/${id}/availability`,
      { rules },
    ),

  unavailability: (companyId: string, id: string, signal?: AbortSignal) =>
    apiClient.get<{ items: ResourceUnavailability[] }>(
      `/companies/${companyId}/resources/${id}/unavailability`,
      { signal },
    ),

  addUnavailability: (
    companyId: string,
    id: string,
    input: {
      startsAt: string;
      endsAt: string;
      reason: UnavailabilityReason;
      note?: string | null;
      allowConflicts?: boolean;
    },
  ) =>
    apiClient.post<ResourceUnavailability>(
      `/companies/${companyId}/resources/${id}/unavailability`,
      input,
    ),

  removeUnavailability: (companyId: string, id: string, unavailabilityId: string) =>
    apiClient.delete<{ deleted: true }>(
      `/companies/${companyId}/resources/${id}/unavailability/${unavailabilityId}`,
    ),
};
