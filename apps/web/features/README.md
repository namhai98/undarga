# Features

Vertical slices. Each folder owns one product area end to end: its data
fetching, its view state and its components.

## Why slices rather than layers

A `components/` + `hooks/` + `services/` split by *technical kind* means one
change to appointments touches three distant folders, and nothing tells you
which parts belong together. Slicing by feature keeps a change local and makes
an unused feature deletable in one `rm -rf`.

The shared layers still exist for genuinely shared things:

    components/ui/   design system primitives (shadcn)
    services/        the API client and cross-cutting API access
    lib/             framework-adjacent singletons (env, cn)
    utils/           pure helpers
    hooks/           cross-feature React hooks

## The one rule that matters

A feature is imported through its `index.ts` and nothing else. Reaching into
`features/appointments/ui/SomeInternalThing` couples two features to each
other's internals and is the fastest way to lose the benefit of slicing.

`system-status/` is the only implemented slice; it is also the worked example.
