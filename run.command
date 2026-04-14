#!/bin/bash
# Launch prototype from worktree build
cd "$(dirname "$0")"

# Start say-server if not already running
if ! lsof -i :8744 >/dev/null 2>&1; then
  python3 say-server.py &
  echo "Started say-server (PID $!)"
fi

./mach run -- -marionette -remote-allow-system-access
