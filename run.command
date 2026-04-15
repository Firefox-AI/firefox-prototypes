#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/obj-aarch64-apple-darwin25.3.0/dist/Nightly.app/Contents/MacOS/firefox" \
  -foreground -no-remote -profile "$DIR/profile-default"
