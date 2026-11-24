#!/bin/sh
# Build rustyTLS-js (against the local rustyTLS fork) from source on Linux without sudo:
# everything happens inside an ubuntu:22.04 container (same glibc as tsss-server), so the
# host only needs Docker. The built addon lands in <dir>/rustyTLS-js/rust/*.node and dist/.
#
# usage: sh build-rustytls-js-linux.sh <dir that contains rustyTLS/ and rustyTLS-js/>
set -eu
SRC=$(cd "${1:-.}" && pwd)
test -d "$SRC/rustyTLS" && test -d "$SRC/rustyTLS-js" || { echo "need $SRC/rustyTLS and $SRC/rustyTLS-js" >&2; exit 2; }
OWNER="$(id -u):$(id -g)"
NODE_VERSION="${NODE_VERSION:-v26.4.0}"

docker run --rm -v "$SRC":/src -v rustytls-cargo-registry:/root/.cargo/registry \
  -e HUSKY=0 -e OWNER="$OWNER" -e NODE_VERSION="$NODE_VERSION" -w /src/rustyTLS-js ubuntu:22.04 sh -euc '
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential cmake perl pkg-config libclang-dev git curl ca-certificates xz-utils >/dev/null
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal -q
  . /root/.cargo/env
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
  rc=0
  { npm ci --ignore-scripts --no-audit --no-fund && npm run build; } || rc=$?
  chown -R "$OWNER" /src/rustyTLS-js /src/rustyTLS  # container runs as root; give files back
  exit $rc
'
