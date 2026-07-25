# walk.tape — the storyboard-walk recording, as a SCRIPT.
#
# The GIF in this repo is only ever produced by CI running this tape
# (see .github/workflows/walk.yml) — never hand-recorded. A recording
# that could drift from the code is a fake receipt with better
# production values; this one is regenerated from the same binary the
# tests just exercised, and the byte-stable transcript law
# (scripts/walk-transcript.sh vs docs/walk-transcript.golden) guards
# the content itself.
#
# CI layout: the workspace root holds sibling checkouts substrate/ and
# sequence/ — the same layout the README quickstart tells a stranger
# to create.

Output substrate/docs/walk.gif

Set Shell "bash"
Set FontSize 13
Set Width 1280
Set Height 840
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Type "cd substrate/services/office-space && node bin/office-space.cjs walk"
Enter
Sleep 4s

# beat 1 — narratives
Enter
Sleep 2.5s
# beat 2 — connector install
Enter
Sleep 2.5s
# beat 3 — the key
Enter
Sleep 2.5s
# beat 4 — the kit + retained exclusion
Enter
Sleep 3s
# beat 5 — descriptions by label
Enter
Sleep 2.5s
# beat 6 — temporal metadata
Enter
Sleep 3s
# beat 7 — consent prompt ("save emails locally? [Y/n]"), then the beat
Enter
Sleep 2.5s
Enter
Sleep 3s
# beat 8 — THE FRAME (linger: this is the centerpiece)
Enter
Sleep 8s
# beat 9 — the learning loop
Enter
Sleep 4s
# beat 10 — usage at the capability grain
Enter
Sleep 3s
# beat 11 — ledgered: frame merge
Enter
Sleep 2.5s
# beat 12 — ledgered: closure chain
Enter
Sleep 3s
# the ledger summary
Sleep 6s
