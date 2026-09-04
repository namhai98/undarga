import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// `lib/env.ts` validates at module load and throws when the API URL is absent,
// so it has to be present before any import chain reaches it.
process.env.NEXT_PUBLIC_API_URL ??= 'http://localhost:3000/api/v1';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
