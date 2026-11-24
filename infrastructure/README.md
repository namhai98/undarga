# Infrastructure

    docker/
      postgres/init/                       first-start SQL, creates the e2e database
      api.Dockerfile                       API image; `--target migrate` = migration job
      web.Dockerfile                       web image (Next standalone; NEXT_PUBLIC_API_URL build arg)
      compose.production.example.yml       single-host production layout — an example to adapt

`docker-compose.yml` at the repository root runs PostgreSQL and Redis only, for
development (bound to 127.0.0.1). The apps run on the host — see the note at
the top of that file.

CI (`.github/workflows/ci.yml`) builds all three images after every check
passes. Building, releasing, migrations, backups and monitoring:
[docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).
