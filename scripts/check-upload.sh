#!/usr/bin/env bash
# Checks what `gcloud run deploy --source .` would upload, before it uploads anything.
# Fails if a Google credentials file made by google-github-actions/auth (gha-creds-*.json)
# would be uploaded, or if package-lock.json is missing (the build needs it for `npm ci`).
set -euo pipefail

source_dir="${1:-.}"
files="$(gcloud meta list-files-for-upload "$source_dir")"

creds="$(printf '%s\n' "$files" | grep -E '(^|/)gha-creds-[^/]*\.json$' || true)"
if [ -n "$creds" ]; then
  echo "::error::Credentials file would be uploaded to Cloud Run:"
  printf '%s\n' "$creds"
  exit 1
fi

if ! printf '%s\n' "$files" | grep -qx 'package-lock.json'; then
  echo "::error::package-lock.json is missing from the upload."
  exit 1
fi

echo "Upload check passed: $(printf '%s\n' "$files" | wc -l | tr -d ' ') files, no credentials, package-lock.json included."
