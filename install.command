#!/bin/zsh
# Double-click this file to install Ordo.
#
# It puts the app in your Applications folder, tells it where this folder is, and
# starts it. Everything it needs stays on this Mac.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

PROJECT_DIR="${0:A:h}"
APP_NAME="Ordo"
BUILT_APP="$PROJECT_DIR/release/mac-arm64/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"
SUPPORT_DIR="$HOME/Library/Application Support/$APP_NAME"

say() { print -r -- "$@"; }
line() { say "------------------------------------------------------------"; }

clear 2>/dev/null || true
line
say "  Installing Ordo"
line
say ""

# 1. Build the app if it has not been built yet -------------------------------
if [[ ! -d "$BUILT_APP" ]]; then
  say "Getting Ordo ready for the first time."
  say "This can take a few minutes. You can leave it running."
  say ""
  if ! command -v node > /dev/null 2>&1; then
    say "PROBLEM: this Mac is missing a piece of software Ordo needs."
    say "Ask whoever set this up for you to install Node, then run this again."
    say ""
    say "Press Return to close this window."
    read -r _
    exit 1
  fi
  ( cd "$PROJECT_DIR" && npm install --silent && npm run app:build ) || {
    say ""
    say "PROBLEM: Ordo could not be prepared."
    say "Send the messages above to whoever set this up for you."
    say ""
    say "Press Return to close this window."
    read -r _
    exit 1
  }
  say ""
fi

if [[ ! -d "$BUILT_APP" ]]; then
  say "PROBLEM: the app was not created. Send this window to whoever set this up."
  say ""
  say "Press Return to close this window."
  read -r _
  exit 1
fi

# 2. Stop any copy that is already running ------------------------------------
say "Stopping any copy that is already open..."
osascript -e "tell application \"$APP_NAME\" to quit" > /dev/null 2>&1
sleep 2
pkill -f "$INSTALLED_APP/Contents/MacOS/" > /dev/null 2>&1
sleep 1

# 3. Copy it into Applications ------------------------------------------------
say "Putting Ordo in your Applications folder..."
rm -rf "$INSTALLED_APP"
cp -R "$BUILT_APP" "$INSTALLED_APP" || {
  say ""
  say "PROBLEM: could not copy the app into Applications."
  say ""
  say "Press Return to close this window."
  read -r _
  exit 1
}

# 4. Remember where the Ordo files live ------------------------------
mkdir -p "$SUPPORT_DIR"
cat > "$SUPPORT_DIR/config.json" <<EOF
{
  "projectDir": "$PROJECT_DIR",
  "port": 5252
}
EOF
chmod 600 "$SUPPORT_DIR/config.json"

# 5. Open it ------------------------------------------------------------------
say "Starting Ordo..."
open "$INSTALLED_APP" 2>/dev/null
OPENED=$?

say ""
line
if [[ $OPENED -eq 0 ]]; then
  say "  Done."
  say ""
  say "  Look at the top-right of your screen: there is now a small speech"
  say "  bubble in the menu bar. Click it any time to open Ordo."
  say ""
  say "  It will start by itself every time you log in. You do not need to"
  say "  keep this window, or any other window, open."
else
  say "  Almost done - macOS blocked the first start."
  say ""
  say "  Open your Applications folder, hold Control and click"
  say "  \"Ordo\", choose Open, then click Open again in the box"
  say "  that appears. You only ever have to do this once."
fi
line
say ""
say "You can close this window now (press Return)."
read -r _
