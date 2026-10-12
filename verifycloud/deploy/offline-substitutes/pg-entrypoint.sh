#!/bin/sh
set -e
mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  printf '%s' "${POSTGRES_PASSWORD:?}" > /tmp/pw && chown postgres /tmp/pw
  su postgres -c "/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U ${POSTGRES_USER:-postgres} --pwfile=/tmp/pw --auth=scram-sha-256" >/dev/null
  rm -f /tmp/pw
  echo "listen_addresses='*'" >> "$PGDATA/postgresql.conf"
  echo "host all all 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -w start -o '-c listen_addresses=localhost'" >/dev/null
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h localhost -U "${POSTGRES_USER:-postgres}" -d postgres -c "CREATE DATABASE \"${POSTGRES_DB:-postgres}\"" >/dev/null 2>&1 || true
  su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -w stop" >/dev/null
fi
exec su postgres -c "/usr/lib/postgresql/16/bin/postgres -D $PGDATA"
