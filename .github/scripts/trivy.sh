#!/usr/bin/env bash
# Runs Trivy from its official image, pinned by digest, so every workflow scans
# with the same scanner and no third-party action runs with the job's token.
# The repository is mounted at /repo (the working directory) and $RUNNER_TEMP
# at /scan; paths passed in must use those mounts. The vulnerability database
# is cached in ~/.cache/trivy between steps.
#
# Usage: .github/scripts/trivy.sh <trivy arguments...>
set -euo pipefail

TRIVY_IMAGE="aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"

mkdir -p "$HOME/.cache/trivy"
exec docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.cache/trivy:/root/.cache/trivy" \
  -v "$PWD:/repo" \
  -v "${RUNNER_TEMP:-/tmp}:/scan" \
  -w /repo \
  "$TRIVY_IMAGE" "$@"
