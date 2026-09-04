import { z } from 'zod';

/**
 * Browser-visible configuration.
 *
 * ---------------------------------------------------------------------------
 * EVERYTHING HERE IS PUBLIC
 * ---------------------------------------------------------------------------
 *
 * `NEXT_PUBLIC_*` variables are inlined into the JavaScript bundle at build
 * time. Anyone who loads the site can read them. That is fine for an API URL
 * and it is catastrophic for anything else, so this schema is an allow-list:
 * a secret cannot leak into the client unless someone adds it here on purpose,
 * and the name makes that obvious in review.
 *
 * Server-only configuration (database URLs, JWT secrets, provider API keys)
 * lives in `apps/api` and is never referenced from this app.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LITERAL process.env.X
 * ---------------------------------------------------------------------------
 *
 * Next replaces `process.env.NEXT_PUBLIC_FOO` textually during the build. It
 * cannot substitute a dynamic lookup, so `process.env[key]` compiles to
 * undefined in the browser. The literals below are required, not a style choice.
 */
const schema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url('NEXT_PUBLIC_API_URL must be an absolute URL, e.g. http://localhost:3000/api/v1'),
});

const parsed = schema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');

  // Thrown at module load, so a missing variable fails the build or the first
  // render with a message naming it — rather than surfacing later as a fetch
  // to "undefined/auth/login".
  throw new Error(`Invalid public environment configuration:\n${issues}`);
}

export const clientEnv = {
  apiUrl: parsed.data.NEXT_PUBLIC_API_URL,
} as const;
