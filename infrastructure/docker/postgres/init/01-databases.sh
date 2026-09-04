#!/bin/bash
# Runs once, on first container start, before the app ever connects.
#
# Creates the e2e database next to the development one. The isolation suite
# truncates every table between cases, so it cannot share a database with the
# data you are clicking through.
#
# The app ROLES (app_tenant, app_platform) are NOT created here — they are
# created by prisma/sql/001_hardening.sql, which also grants them and attaches
# the row-level security policies. Splitting role creation from policy
# attachment is how you end up with a role that has grants and no policies.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  SELECT 'CREATE DATABASE undarga_test'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'undarga_test')\gexec
SQL

echo "init: undarga_test database ready"
