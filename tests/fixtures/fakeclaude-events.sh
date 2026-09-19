#!/bin/sh
# tests/fixtures/fakeclaude-events.sh — minimal fake claude for the transcript
# mode/guard test (0408/S4): emits one stream-json system/init line (so the
# Agent's event handler runs and lazily opens the on-disk transcript), then
# stays alive briefly so the test can inspect the file before kill().
if [ "$1" = "--version" ]; then echo "0.0.0 (fake-events)"; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"fake","model":"claude-test-1"}'
exec /bin/sleep 10
