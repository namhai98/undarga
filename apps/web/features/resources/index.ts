/**
 * Rooms, chairs and equipment: weekly booking windows and unavailable
 * periods, read by the same availability engine that books staff.
 */
export {
  resourceKeys,
  useResourceTypes,
  useResources,
  useResourceWindows,
  useResourceUnavailability,
} from './api/use-resources';
export { ResourcesPage } from './ui/resources-page';
