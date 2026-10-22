# `platform` feature

The operator console. Completely separate from company-level RBAC.

## Layout

    api/    TanStack Query hooks over `@/services/platform.service`.
    ui/     Components. Only this folder is imported by `app/(platform)/`.

## Three things worth knowing before editing this

**It has its own session.** `platformTokenStore` and `platformApiClient` are
separate from the staff ones on purpose. One shared module-level store would
mean signing into the console logs you out of the company app in the same tab.
Never import `@/services/api-client` or `token-store` here.

**A reload signs you out.** There is no platform refresh endpoint and the
refresh cookie is scoped to the staff path, so the session is memory-only. The
login screen says so rather than leaving it to be discovered.

**The console shows counts, never tenant contents.** Customer names, phone
numbers and appointment details are not in any response this feature reads, and
nothing here should start asking for them. An operator sizes a tenant and
supports its staff; reading its customers is a different, larger grant.

## Rules

- Cross-feature imports go through `index.ts`.
- `PlatformShell`'s sign-in gate is a redirect, not protection. The boundary is
  `@PlatformOnly` on the API, which rejects a staff token at the audience check
  (`docs/ARCHITECTURE-RULES.md`, rule 3).
- Company status labels live in `ui/status.tsx`. The API vocabulary is never
  relabelled on the wire — only on screen.
