#!/bin/bash
# Usage: ./release.sh <version> [--retry]
# Example: ./release.sh 0.1.2
#          ./release.sh 0.1.2 --retry   # re-triggers the same tag after a failed CI run
#
# Bumps the version, checks everything, commits, tags and pushes. The tag
# triggers .github/workflows/release.yml, which publishes to npm and creates
# the GitHub Release. Add a "## <version>" section to CHANGELOG.md first.

set -e

VERSION="${1:?'Usage: ./release.sh <version>  e.g. ./release.sh 0.1.2'}"
RETRY=false
[[ "${2}" == "--retry" ]] && RETRY=true

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be in semver format (e.g. 1.2.3)"
  exit 1
fi

REPO=$(git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/.git$//')

if $RETRY; then
  echo "Retrying release v$VERSION..."
  git tag -d "v$VERSION" 2>/dev/null || true
  git push origin ":refs/tags/v$VERSION" 2>/dev/null || true
  git tag -a "v$VERSION" -m "v$VERSION"
  git push origin "v$VERSION"
  echo ""
  echo "Re-triggered v$VERSION."
  echo "Monitor: https://github.com/$REPO/actions"
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: commit or stash your changes first"
  exit 1
fi

if ! grep -q "^## $VERSION\$" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no '## $VERSION' section"
  exit 1
fi

echo "Preparing release v$VERSION..."
npm version "$VERSION" --no-git-tag-version > /dev/null

echo "Checking (typecheck, tests, build)..."
npm run check

echo "Committing and tagging..."
git add package.json package-lock.json CHANGELOG.md
git diff --staged --quiet || git commit -m "Release v$VERSION"
git tag -a "v$VERSION" -m "v$VERSION"
git push origin main "v$VERSION"

echo ""
echo "Released v$VERSION."
echo "GitHub Actions is now publishing it to npm and creating the GitHub Release."
echo "Monitor: https://github.com/$REPO/actions"
