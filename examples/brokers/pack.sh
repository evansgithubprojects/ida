#!/usr/bin/env sh
# Builds the Ida JS packages in this repo and packs them into examples/brokers/packs, where package.json installs
# them from. Run it again after changing a package.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cd "$root"
npm run build:packages
rm -rf "$here/packs"
mkdir -p "$here/packs"
npm pack --pack-destination "$here/packs" \
  -w @ida-dev/core -w @ida-dev/adapter-eventemitter -w @ida-dev/adapter-kafkajs -w @ida-dev/adapter-amqplib -w @ida-dev/cloud
