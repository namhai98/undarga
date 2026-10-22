import { CalendarIntegrationPage } from '@/features/calendar';

export default async function CalendarRoute({ searchParams }: PageProps<'/calendar'>) {
  const params = await searchParams;
  return <CalendarIntegrationPage justConnected={params.connected === '1'} />;
}
