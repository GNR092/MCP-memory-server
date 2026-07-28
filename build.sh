#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
echo "================================================"
echo "  Building MCP Memory Server ${TAG}"
echo "================================================"

docker build \
  --build-arg VERSION="${VERSION}" \
  --network host \
  -t "gnr092/memoryproxy:${TAG}" \
  -t gnr092/memoryproxy:latest \
  .

echo ""
echo "✅ Build complete: gnr092/memoryproxy:${TAG}"
echo "   docker push gnr092/memoryproxy:${TAG}"
echo "   docker push gnr092/memoryproxy:latest"
