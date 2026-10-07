#!/bin/sh
# Pretend air traffic control calls about the planes Look Up can see now,
# dropped into the radio inbox (see scripts/atc-test-calls.js). Runs in a
# throwaway container with espeak-ng and ffmpeg, so nothing needs installing.
#
#   scripts/atc-test-calls.sh [look-up URL] [inbox folder] [how many planes]
#   scripts/atc-test-calls.sh http://localhost:8095 /opt/usenet/config/look-up/atc/inbox
set -e
URL=${1:-http://localhost:8080}
INBOX=$(realpath -m "${2:-data/atc/inbox}")
COUNT=${3:-3}
HERE=$(dirname "$(realpath "$0")")
mkdir -p "$INBOX"
# Root inside the container to install espeak-ng; the recording is handed back to you.
docker run --rm --network host \
  -v "$HERE:/scripts:ro" -v "$INBOX:/inbox" \
  --entrypoint sh node:22-alpine -c \
  "apk add --no-cache -q espeak-ng ffmpeg >/dev/null && node /scripts/atc-test-calls.js '$URL' /inbox '$COUNT' && chown $(id -u):$(id -g) /inbox/test-calls-*.mp3"
