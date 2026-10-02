import { z } from 'zod';
import type {
  PublicBookingConfirmation,
  PublicService,
  PublicSlot,
} from '@/services/public-booking.service';

/**
 * The booking page's view state: which step, and what has been chosen.
 *
 *   branch → service → employee → time → details → confirmed
 *
 * View state only — never a rule about what is bookable. The server decides
 * that on every request. What this does own is navigation: changing an earlier
 * choice clears every later one, so a time picked for one service can never be
 * submitted for another.
 */

export type Step = 'branch' | 'service' | 'employee' | 'time' | 'details' | 'confirmed';

export interface FlowState {
  step: Step;
  branchId: string | null;
  service: PublicService | null;
  /** `null` = "anyone available". Only meaningful once `employeeChosen`. */
  employeeId: string | null;
  employeeChosen: boolean;
  date: string | null;
  slot: PublicSlot | null;
  confirmation: PublicBookingConfirmation | null;
  /** Shown on the time step after a slot was lost to someone else. */
  notice: string | null;
}

export type FlowAction =
  | { type: 'branch'; branchId: string }
  | { type: 'service'; service: PublicService }
  | { type: 'employee'; employeeId: string | null }
  | { type: 'date'; date: string }
  | { type: 'slot'; slot: PublicSlot }
  | { type: 'back' }
  | { type: 'goto'; step: Step }
  | { type: 'slotLost'; message: string }
  | { type: 'confirmed'; confirmation: PublicBookingConfirmation }
  | { type: 'restart' };

export function initialState(onlyBranchId: string | null, today: string): FlowState {
  return {
    step: onlyBranchId ? 'service' : 'branch',
    branchId: onlyBranchId,
    service: null,
    employeeId: null,
    employeeChosen: false,
    date: today,
    slot: null,
    confirmation: null,
    notice: null,
  };
}

const ORDER: Step[] = ['branch', 'service', 'employee', 'time', 'details', 'confirmed'];

/** The steps this booking actually walks through. */
export function stepsFor(state: Pick<FlowState, 'service'>, singleBranch: boolean): Step[] {
  return ORDER.filter(
    (s) =>
      s !== 'confirmed' &&
      !(s === 'branch' && singleBranch) &&
      !(s === 'employee' && state.service && !state.service.requiresEmployee),
  );
}

export function reducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'branch':
      return {
        ...state,
        step: 'service',
        branchId: action.branchId,
        service: null,
        employeeId: null,
        employeeChosen: false,
        slot: null,
        notice: null,
      };

    case 'service':
      return {
        ...state,
        step: action.service.requiresEmployee ? 'employee' : 'time',
        service: action.service,
        employeeId: null,
        // A service with nobody to choose goes straight to times.
        employeeChosen: !action.service.requiresEmployee,
        slot: null,
        notice: null,
      };

    case 'employee':
      return {
        ...state,
        step: 'time',
        employeeId: action.employeeId,
        employeeChosen: true,
        slot: null,
        notice: null,
      };

    case 'date':
      return { ...state, date: action.date, slot: null, notice: null };

    case 'slot':
      return { ...state, step: 'details', slot: action.slot, notice: null };

    case 'slotLost':
      return { ...state, step: 'time', slot: null, notice: action.message };

    case 'confirmed':
      return { ...state, step: 'confirmed', confirmation: action.confirmation };

    case 'goto':
      return canVisit(state, action.step) ? { ...state, step: action.step, notice: null } : state;

    case 'back': {
      const i = ORDER.indexOf(state.step);
      for (let j = i - 1; j >= 0; j -= 1) {
        const candidate = ORDER[j]!;
        if (candidate === 'employee' && state.service && !state.service.requiresEmployee) continue;
        if (canVisit(state, candidate)) return { ...state, step: candidate, notice: null };
      }
      return state;
    }

    case 'restart':
      // Book another: keep the branch, start over from the service.
      return initialState(state.branchId, state.date ?? isoDay());
  }
}

/** A step is reachable once everything before it has been chosen. */
export function canVisit(state: FlowState, step: Step): boolean {
  if (state.step === 'confirmed') return step === 'confirmed';
  switch (step) {
    case 'branch':
      return true;
    case 'service':
      return Boolean(state.branchId);
    case 'employee':
      return Boolean(state.branchId && state.service?.requiresEmployee);
    case 'time':
      return Boolean(state.branchId && state.service && state.employeeChosen);
    case 'details':
      return Boolean(state.slot);
    case 'confirmed':
      return Boolean(state.confirmation);
  }
}

/**
 * The customer form, mirroring the API's validation so a mistake is caught
 * before a round trip. The server validates again regardless.
 */
export const customerFormSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name.').max(96),
  lastName: z.string().trim().max(96).optional(),
  phone: z
    .string()
    .trim()
    .min(1, 'Enter your phone number.')
    .max(32)
    .regex(/^\+?[\d\s()./-]+$/, 'Enter a valid phone number.')
    .refine((v) => v.replace(/\D/g, '').length >= 6, 'That phone number is too short.'),
  email: z
    .string()
    .trim()
    .max(320)
    .email('Enter a valid email address.')
    .optional()
    .or(z.literal('')),
  note: z.string().trim().max(1000).optional(),
});
export type CustomerFormValues = z.infer<typeof customerFormSchema>;

/** `YYYY-MM-DD` for today plus `offset` days, in the visitor's calendar. */
export function isoDay(offset = 0, from = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `2026-10-06T09:00:00+08:00` → `09:00` — the branch's wall clock, as-is. */
export function wallTime(iso: string): string {
  return iso.slice(11, 16);
}

/**
 * `2026-10-06` → `Tue 6 Oct`. The date is a branch calendar date with no
 * instant attached, so it is formatted at UTC noon in UTC — the weekday can
 * never slip a day because of the viewer's own zone.
 */
export function formatDay(isoDate: string, locale?: string, long = false): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    weekday: long ? 'long' : 'short',
    day: 'numeric',
    month: long ? 'long' : 'short',
    ...(long ? { year: 'numeric' as const } : {}),
  }).format(d);
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The company's brand colour as the page's primary token — only if it is a
 * plain hex colour. Anything else is ignored rather than written into a style
 * attribute, and the foreground is picked for contrast rather than trusted.
 */
export function brandStyle(color: string | null | undefined): Record<string, string> | undefined {
  if (!color || !HEX.test(color)) return undefined;
  const full =
    color.length === 4 ? `#${[...color.slice(1)].map((c) => c + c).join('')}` : color;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {
    '--primary': full,
    '--primary-foreground': luminance > 0.6 ? '#111111' : '#ffffff',
    '--ring': full,
  };
}
