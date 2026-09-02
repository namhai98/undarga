// Isolation tests exercise real Postgres round trips through three guards and
// an interactive transaction per query; the default 5s is too tight on a cold
// container.
jest.setTimeout(30_000);
