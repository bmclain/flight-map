#!/bin/sh
# Download the model on first start, then serve /inference on port 8080.
set -e
model="/models/ggml-${WHISPER_MODEL}.bin"
if [ ! -f "$model" ]; then
  echo "downloading $model"
  curl -fL -o "$model.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin"
  mv "$model.part" "$model"
fi
# WHISPER_ARGS: extra options, e.g. "--audio-ctx 768" (a 15 s window: radio
# calls are short, and it halves the time each takes).
# shellcheck disable=SC2086
exec whisper-server -m "$model" -t "$WHISPER_THREADS" --host 0.0.0.0 --port 8080 $WHISPER_ARGS "$@"
