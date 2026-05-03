# Strata demo tape — renders a short terminal GIF for the README hero.
#
# Tooling: VHS (https://github.com/charmbracelet/vhs) — install with
#   go install github.com/charmbracelet/vhs@latest
# or
#   brew install vhs
# or
#   winget install charmbracelet.vhs
#
# Run from the strata sub-repo:
#   vhs docs/assets/demo.tape
#
# Output: docs/assets/strata-demo.gif (then update README to point at it).

Output docs/assets/strata-demo.gif

Set Shell      "pwsh"
Set FontSize   14
Set Width      1100
Set Height     620
Set Theme      "Catppuccin Mocha"
Set Padding    20
Set TypingSpeed 40ms

# --- Scene 1: index health ---
Type "strata status"
Sleep 400ms
Enter
Sleep 2500ms

# --- Scene 2: store a decision ---
Type "strata store-memory 'Use bcrypt with cost factor 12 for password hashing' --type decision"
Sleep 400ms
Enter
Sleep 2000ms

# --- Scene 3: recall it from a different vocabulary ---
Type "strata search 'how do we hash passwords'"
Sleep 400ms
Enter
Sleep 4000ms
