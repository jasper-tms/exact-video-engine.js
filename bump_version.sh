#!/usr/bin/env bash
#
# Cut a release: repoint the pinned CDN URLs at a new version, commit that, and
# tag the commit.
#
# Order matters. The tag has to point at a commit whose demo.html and README
# already reference that same tag, so it goes rewrite -> commit -> tag. Tagging
# first would ship a demo page that loads the PREVIOUS release from jsDelivr,
# which is exactly the kind of thing nobody notices until a consumer does.
#
# Usage:
#   ./bump_version.sh v1.2.0     explicit version
#   ./bump_version.sh patch      v1.1.0 -> v1.1.1
#   ./bump_version.sh minor      v1.1.0 -> v1.2.0
#   ./bump_version.sh major      v1.1.0 -> v2.0.0
#
#   ./bump_version.sh minor --push    also push the commit and the tag
#
# Without --push nothing leaves the machine; the script prints the two commands
# to run when you are ready. jsDelivr cannot serve the tag until it is pushed,
# so the demo page and both consumers stay on the previous release until then.
set -euo pipefail
cd "$(dirname "$0")"

PUSH=false
BUMP=""
for argument in "$@"; do
    case "$argument" in
        --push) PUSH=true ;;
        -h|--help) sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) BUMP="$argument" ;;
    esac
done

if [ -z "$BUMP" ]; then
    echo "usage: ./bump_version.sh <version|major|minor|patch> [--push]" >&2
    exit 1
fi

# The version the pinned URLs currently point at. Read it out of demo.html
# rather than from `git tag`, so that a hand-edited pin cannot silently disagree
# with what we are bumping from.
CURRENT=$(grep -o 'exact-video-engine\.js@v[0-9]\+\.[0-9]\+\.[0-9]\+' demo.html \
    | head -1 | sed 's/.*@//')
if [ -z "$CURRENT" ]; then
    echo "error: no pinned version found in demo.html" >&2
    exit 1
fi

case "$BUMP" in
    major|minor|patch)
        IFS=. read -r major minor patch <<< "${CURRENT#v}"
        case "$BUMP" in
            major) VERSION="v$((major + 1)).0.0" ;;
            minor) VERSION="v${major}.$((minor + 1)).0" ;;
            patch) VERSION="v${major}.${minor}.$((patch + 1))" ;;
        esac
        ;;
    *)
        VERSION="$BUMP"
        ;;
esac

if ! [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: '$VERSION' is not vMAJOR.MINOR.PATCH" >&2
    exit 1
fi
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
    echo "error: tag $VERSION already exists" >&2
    exit 1
fi
# Tags are immutable once pushed and jsDelivr caches them forever, so a release
# must be cut from a tree with nothing uncommitted hiding in it.
if [ -n "$(git status --porcelain)" ]; then
    echo "error: working tree is not clean; commit or stash first" >&2
    git status --short >&2
    exit 1
fi

echo "Bumping $CURRENT -> $VERSION"

# Repoint every pinned CDN URL. demo.html is the demo; the README carries the
# same pin in its usage snippet, and a stale one there is what consumers copy.
FILES=(demo.html README.md)
replaced=0
for file in "${FILES[@]}"; do
    before=$(grep -c "exact-video-engine\.js@${CURRENT}/" "$file" || true)
    if [ "$before" -gt 0 ]; then
        perl -pi -e "s{exact-video-engine\.js\@\Q${CURRENT}\E/}{exact-video-engine.js\@${VERSION}/}g" "$file"
        echo "  $file: $before pin(s) updated"
        replaced=$((replaced + before))
    fi
done
if [ "$replaced" -eq 0 ]; then
    echo "error: no pins matched $CURRENT; nothing changed" >&2
    exit 1
fi

git add "${FILES[@]}"
git commit -m "Release $VERSION"
git tag -a "$VERSION" -m "Release $VERSION"

echo
echo "Committed and tagged $VERSION locally."
if [ "$PUSH" = true ]; then
    git push origin HEAD
    git push origin "$VERSION"
    echo "Pushed. jsDelivr will serve $VERSION shortly (tags are cached forever once fetched)."
else
    echo "Nothing has been pushed. When ready:"
    echo "    git push origin HEAD && git push origin $VERSION"
fi
