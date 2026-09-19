#!/bin/sh
# tests/fixtures/fakeclaude-wedged.sh — stand-in for a wedged claude that
# ignores SIGTERM/SIGHUP (a permission prompt / daemon entanglement). Used by
# the shutdown-escalation regression test (0408/P5): SIGTERM must leave it
# running, SIGKILL must reap it. `trap ''` marks the signals SIG_IGN, which
# survives the exec into sleep.
if [ "$1" = "--version" ]; then echo "0.0.0 (fake-wedged)"; exit 0; fi
trap '' TERM HUP
exec /bin/sleep 300
