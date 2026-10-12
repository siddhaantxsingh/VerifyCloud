FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates && rm -rf /var/lib/apt/lists/*
# optional extra CAs for TLS-intercepting build networks (extra-ca/*.crt, not committed)
COPY extra-ca/ /usr/local/share/ca-certificates/extra/
RUN update-ca-certificates >/dev/null 2>&1; pip3 install --break-system-packages --no-cache-dir --cert /etc/ssl/certs/ca-certificates.crt "moto[server]==5.2.3"
COPY mc-shim.py /usr/local/bin/mc
RUN chmod 755 /usr/local/bin/mc
EXPOSE 9000
# accepts and ignores MinIO's "server /data --console-address :9001" arguments
ENTRYPOINT ["sh", "-c", "exec moto_server -H 0.0.0.0 -p 9000", "--"]
