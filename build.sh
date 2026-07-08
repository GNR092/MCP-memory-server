#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
echo "================================================"
echo "  Building MCP Memory Server v${VERSION}"
echo "================================================"

docker build \
  --build-arg VERSION="${VERSION}" \
  --network host \
  -t "gnr092/memoryproxy:${VERSION}" \
  -t gnr092/memoryproxy:latest \
  .

echo ""
echo "✅ Build complete: gnr092/memoryproxy:${VERSION}"
echo "   docker push gnr092/memoryproxy:${VERSION}"
echo "   docker push gnr092/memoryproxy:latest"
