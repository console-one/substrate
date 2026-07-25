#!/usr/bin/env bash
# walk-transcript.sh — the scripted storyboard walk, normalized to its
# byte-stable form. This output IS the un-liable property behind the
# GIF: CI diffs it against docs/walk-transcript.golden on every push,
# so the recording can never show something the code doesn't do.
#
# The ONLY normalization is the observed-latency digits: those are real
# measurements of real local calls (the honesty rule), so their exact
# values legitimately vary by machine. Everything else — every fact,
# every count, every session id (injected clock), every ledger line —
# must be byte-identical.
set -euo pipefail
cd "$(dirname "$0")/../services/office-space"
node bin/office-space.cjs walk --scripted \
  | sed -E 's/~survival\(exp, [0-9.eE+-]+\)/~survival(exp, OBSERVED)/g' \
  | sed -E 's/(_latency = \{ shape: [0-9]+, rate: )[0-9.eE+-]+/\1OBSERVED/g'
