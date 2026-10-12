# Simulation sandbox image: the only place untrusted HDL is compiled and run.
# Contains Verilator, a C++ toolchain and the VerifyCloud harness; no network
# tools, no credentials. Runs as an unprivileged user.
#
#   docker build -t verifycloud-sim:verilator -f deploy/sim-image/Dockerfile .
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends verilator g++ make libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 sim && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sim
COPY packages/worker/harness/vc_main.cpp /opt/verifycloud/harness/vc_main.cpp
# Record the toolchain versions inside the image (reproducibility metadata).
RUN { echo "verilator=$(verilator --version | head -1)"; echo "gcc=$(g++ -dumpfullversion)"; } > /opt/verifycloud/toolchain.txt
USER 10001:10001
WORKDIR /work
