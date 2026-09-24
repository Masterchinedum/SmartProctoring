# Points the server, seed/migrate scripts and every test suite at the services in docker-compose.dev.yml.
#   source scripts/dev-env.sh        (once per terminal, from the repository root; zsh or bash)
export SP_DEV_PG_PORT="${SP_DEV_PG_PORT:-5434}"
export SP_DEV_REDIS_PORT="${SP_DEV_REDIS_PORT:-6380}"

export DATABASE_URL="postgres://postgres@127.0.0.1:${SP_DEV_PG_PORT}/proctor"               # pnpm dev, seed, db:migrate
export TEST_DATABASE_ADMIN_URL="postgres://postgres@127.0.0.1:${SP_DEV_PG_PORT}/postgres"   # server tests (template DB per run)
export E2E_DATABASE_URL="postgres://postgres@127.0.0.1:${SP_DEV_PG_PORT}/proctor_e2e"       # e2e (dropped + re-created each run)
export TEST_REDIS_URL="redis://127.0.0.1:${SP_DEV_REDIS_PORT}"                              # Redis-backed server tests
# The dev server runs without Redis (single instance). To try multi-instance fan-out: export REDIS_URL="$TEST_REDIS_URL"

echo "SmartProctoring dev env: Postgres 127.0.0.1:${SP_DEV_PG_PORT}, Redis 127.0.0.1:${SP_DEV_REDIS_PORT}"
