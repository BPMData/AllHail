#!/usr/bin/env bash
# After `gcloud run deploy`, checks that the deploy really took effect:
# a new ready revision, labelled with this commit, serving traffic at the live URL.
# Usage: scripts/check-deploy.sh <prior-revision> <commit-sha>
set -euo pipefail

prior="${1:?prior revision name required}"
sha="${2:?commit sha required}"
service="${SERVICE:-allhail}"
region="${REGION:-us-east1}"
project="${PROJECT:-loyal-rookery-403218}"

describe() {
  gcloud run services describe "$service" --region "$region" --project "$project" --format="value($1)"
}

latest="$(describe status.latestReadyRevisionName)"
url="$(describe status.url)"
echo "Prior revision: ${prior}"
echo "New revision:   ${latest}"

if [ -z "$latest" ] || [ "$latest" = "$prior" ]; then
  echo "::error::No new ready revision (still ${latest:-none})."
  exit 1
fi

label="$(gcloud run revisions describe "$latest" --region "$region" --project "$project" \
  --format='value(metadata.labels.commit-sha)')"
if [ "$label" != "$sha" ]; then
  echo "::error::Revision ${latest} has commit-sha '${label}', expected '${sha}'."
  exit 1
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 --retry 3 --retry-all-errors "${url}/api/health")"
case "$code" in
  2??|3??) echo "Live check passed: ${url}/api/health returned ${code}." ;;
  *) echo "::error::${url}/api/health returned ${code}."; exit 1 ;;
esac
