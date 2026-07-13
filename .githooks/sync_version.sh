#!/usr/bin/env bash
#
# Bring the pinned jsDelivr URLs in demo.html and README.md in line with VERSION.
#
# VERSION is the single source of truth for which release this tree is. Every
# other place that names a version -- the demo page's <script src>, the README's
# usage snippet -- is derived from it here, and the pre-commit hook runs this so
# the derivation cannot drift.
#
# Usage, from anywhere in the tree:
#   .githooks/sync_version.sh          rewrite the pins in place to match VERSION
#   .githooks/sync_version.sh --check  exit 1 if any pin disagrees with VERSION
#
# Mostly it is not run by hand: the pre-commit hook next to it runs it so the
# derivation cannot drift, and --check is what the release workflow runs before
# it tags. Tags are immutable and jsDelivr caches them forever, so a tag placed
# on a commit whose demo page still loads the PREVIOUS release is exactly the
# kind of thing nobody notices until a consumer does. CI refuses to cut one.
set -euo pipefail

# The files this rewrites live at the top of the tree, not next to this script.
cd "$(dirname "$0")/.."

CHECK=false
case "${1:-}" in
    --check) CHECK=true ;;
    -h|--help) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    '') ;;
    *) echo "usage: .githooks/sync_version.sh [--check]" >&2; exit 1 ;;
esac

VERSION=$(tr -d '[:space:]' < VERSION)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: VERSION must be MAJOR.MINOR.PATCH with no leading 'v'; got '$VERSION'" >&2
    exit 1
fi

# The trailing slash is load-bearing: it matches a pin only where it sits inside
# a CDN URL, and never prose like "Before v1.2.1 a canvas with no parent element
# threw out of load()", which is a statement about history and must not be
# rewritten to name the current release.
PIN='exact-video-engine\.js@v[0-9]+\.[0-9]+\.[0-9]+/'
FILES=(demo.html README.md)

stale_files=0
for file in "${FILES[@]}"; do
    pins=$(grep -Eo "$PIN" "$file" || true)
    total=$(printf '%s' "$pins" | grep -c . || true)
    stale=$(printf '%s' "$pins" | grep -vcF "@v${VERSION}/" || true)

    if [ "$total" -eq 0 ]; then
        echo "error: $file contains no pinned CDN URL; did the snippet move?" >&2
        exit 1
    fi
    if [ "$stale" -eq 0 ]; then
        continue
    fi

    if [ "$CHECK" = true ]; then
        echo "$file: $stale pin(s) disagree with VERSION ($VERSION):" >&2
        grep -nE "$PIN" "$file" | grep -vF "@v${VERSION}/" >&2 || true
        stale_files=$((stale_files + 1))
    else
        perl -pi -e "s{exact-video-engine\.js\@v[0-9]+\.[0-9]+\.[0-9]+/}{exact-video-engine.js\@v${VERSION}/}g" "$file"
        echo "$file: $stale pin(s) -> v${VERSION}"
    fi
done

if [ "$CHECK" = true ] && [ "$stale_files" -gt 0 ]; then
    echo >&2
    echo "Run .githooks/sync_version.sh to bring them in line with VERSION, and commit the result." >&2
    exit 1
fi
