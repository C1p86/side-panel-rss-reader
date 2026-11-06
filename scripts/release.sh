#!/usr/bin/env bash
# Bumps the version in manifest.json, commits and tags it, pushes, and publishes
# a GitHub release with the packaged extension attached.
#
# Usage: scripts/release.sh [patch|minor|major] [--dry-run]
set -euo pipefail

bump=patch
dry_run=false
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) bump=$arg ;;
    --dry-run) dry_run=true ;;
    *) echo "Usage: scripts/release.sh [patch|minor|major] [--dry-run]" >&2; exit 2 ;;
  esac
done

fail() { echo "Error: $1" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"

[ "$(git branch --show-current)" = main ] || fail "releases are made from the main branch."
[ -z "$(git status --porcelain)" ] || fail "the working tree has uncommitted changes."
git fetch --quiet origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "main is not in sync with origin/main."
gh auth status >/dev/null 2>&1 || fail "the GitHub CLI is not signed in. Run: gh auth login"

# gh cannot resolve SSH host aliases in remotes, so the repository is always passed explicitly.
repo=$(git remote get-url origin | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')

current=$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' manifest.json)
[ -n "$current" ] || fail "no x.y.z version found in manifest.json."
IFS=. read -r major minor patch <<< "$current"
case "$bump" in
  major) version="$((major + 1)).0.0" ;;
  minor) version="$major.$((minor + 1)).0" ;;
  patch) version="$major.$minor.$((patch + 1))" ;;
esac
tag="v$version"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null || [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  fail "tag $tag already exists."
fi

if [ "$dry_run" = true ]; then
  echo "Would release $tag (from $current) to $repo. Nothing was changed."
  exit 0
fi

zip_dir=$(mktemp -d)
zip_file="$zip_dir/${repo##*/}-$version.zip"
pushed=false

# Before the push nothing is public, so a failure can undo the local commit and tag.
on_exit() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$pushed" = false ]; then
    git tag --delete "$tag" >/dev/null 2>&1 || true
    if [ "$(git log -1 --format=%s)" = "Release $tag" ]; then git reset --quiet --hard HEAD~1; fi
    echo "Error: nothing was published. Local changes were undone." >&2
  fi
  rm -rf "$zip_dir"
}
trap on_exit EXIT

sed -i -E "s/^([[:space:]]*\"version\":[[:space:]]*\")[0-9]+\.[0-9]+\.[0-9]+/\1$version/" manifest.json
git add manifest.json
git commit --quiet -m "Release $tag"
git tag --annotate "$tag" -m "Release $tag"
git archive --format=zip --output="$zip_file" "$tag" # Files marked export-ignore in .gitattributes stay out.

git push --quiet --atomic origin main "$tag"
pushed=true

if ! gh release create "$tag" "$zip_file" --repo "$repo" --title "$tag" --generate-notes --verify-tag; then
  echo "Error: $tag was pushed, but the release was not created. To retry, run:" >&2
  echo "  git archive --format=zip --output=extension.zip $tag" >&2
  echo "  gh release create $tag extension.zip --repo $repo --title $tag --generate-notes --verify-tag" >&2
  exit 1
fi

echo "Released $tag: https://github.com/$repo/releases/tag/$tag"
