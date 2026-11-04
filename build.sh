#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
DOCKER_TAGS=(-t "gnr092/memoryproxy:${TAG}")
if [[ "${VERSION}" != *-* ]]; then
  DOCKER_TAGS+=(-t gnr092/memoryproxy:latest)
fi
echo "================================================"
echo "  Building MCP Memory Server ${TAG}"
echo "================================================"

docker build \
  --build-arg VERSION="${VERSION}" \
  --network host \
  "${DOCKER_TAGS[@]}" \
  .

echo ""
echo "✅ Build complete: gnr092/memoryproxy:${TAG}"
echo "   docker push gnr092/memoryproxy:${TAG}"
if [[ "${VERSION}" != *-* ]]; then
  echo "   docker push gnr092/memoryproxy:latest"
fi
