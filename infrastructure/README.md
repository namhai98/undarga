# Infrastructure

    docker/
      postgres/init/   first-start SQL, creates the e2e database
      api.Dockerfile   production image for apps/api
      web.Dockerfile   production image for apps/web

`docker-compose.yml` at the repository root runs PostgreSQL and Redis only. The
apps run on the host during development — see the note at the top of that file
for why.

Neither Dockerfile is exercised by CI yet, so treat both as a starting point
rather than a verified build. `web.Dockerfile` additionally needs
`output: 'standalone'` in `apps/web/next.config.ts`.
