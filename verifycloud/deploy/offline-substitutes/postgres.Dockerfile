FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-16 && rm -rf /var/lib/apt/lists/*
ENV PATH=/usr/lib/postgresql/16/bin:$PATH PGDATA=/var/lib/postgresql/data
COPY pg-entrypoint.sh /usr/local/bin/pg-entrypoint.sh
RUN chmod 755 /usr/local/bin/pg-entrypoint.sh && mkdir -p /var/run/postgresql && chown postgres:postgres /var/run/postgresql
EXPOSE 5432
ENTRYPOINT ["/usr/local/bin/pg-entrypoint.sh"]
