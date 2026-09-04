import { describe, expect, it } from 'vitest';
import { clientEnv } from './env';

describe('clientEnv', () => {
  it('exposes the API URL', () => {
    expect(clientEnv.apiUrl).toMatch(/^https?:\/\//);
  });

  it('exposes ONLY the API URL', () => {
    // A guard against someone adding a server secret to the public schema.
    // NEXT_PUBLIC_* is compiled into the browser bundle and is readable by
    // anyone who loads the page.
    expect(Object.keys(clientEnv)).toEqual(['apiUrl']);
  });
});
