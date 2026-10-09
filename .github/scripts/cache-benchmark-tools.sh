#!/usr/bin/env bash
set -euo pipefail

root="$RUNNER_TEMP/cache-benchmark-zstd"
mkdir -p "$root"
curl --fail --location --silent --show-error \
  https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz \
  --output "$root/zstd.tar.gz"
echo "eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3  $root/zstd.tar.gz" | sha256sum --check
tar -xzf "$root/zstd.tar.gz" -C "$root"
make -C "$root/zstd-1.5.7/programs" -j2 zstd HAVE_ZLIB=0 HAVE_LZMA=0 HAVE_LZ4=0
echo "$root/zstd-1.5.7/programs" >> "$GITHUB_PATH"
"$root/zstd-1.5.7/programs/zstd" --version
