#!/bin/zsh
# Double-click this file to remove Ordo from this Mac.
#
# It removes the app itself and stops it starting automatically. It does NOT
# touch the Ordo folder, your Slack sign-in details, or your saved
# messages - those stay exactly where they are.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

APP_NAME="Ordo"
INSTALLED_APP="/Applications/$APP_NAME.app"
SUPPORT_DIR="$HOME/Library/Application Support/$APP_NAME"
LOG_DIR="$HOME/Library/Logs/$APP_NAME"

say() { print -r -- "$@"; }
line() { say "------------------------------------------------------------"; }

clear 2>/dev/null || true
line
say "  Removing Ordo"
line
say ""
say "This will:"
say "  - close Ordo"
say "  - stop it starting automatically when you log in"
say "  - remove it from your Applications folder"
say ""
say "This will NOT remove:"
say "  - the Ordo folder on your Mac"
say "  - your Slack sign-in details"
say "  - the messages it has already collected"
say ""
say "Type  remove  and press Return to go ahead."
say "Press Return on its own to cancel."
printf "> "
read -r ANSWER

if [[ "$ANSWER" != "remove" ]]; then
  say ""
  say "Cancelled. Nothing was changed."
  say ""
  say "Press Return to close this window."
  read -r _
  exit 0
fi

say ""

# 1. Stop it starting at login (has to happen while the app still exists) ------
if [[ -x "$INSTALLED_APP/Contents/MacOS/$APP_NAME" ]]; then
  say "Stopping it from starting automatically..."
  "$INSTALLED_APP/Contents/MacOS/$APP_NAME" --unregister-login-item > /dev/null 2>&1
  sleep 1
fi

# 2. Close it -----------------------------------------------------------------
say "Closing Ordo..."
osascript -e "tell application \"$APP_NAME\" to quit" > /dev/null 2>&1
sleep 2
pkill -f "$INSTALLED_APP/Contents/MacOS/" > /dev/null 2>&1
# Also stop the background part, if it is still running.
pkill -f -- "--copilot-managed" > /dev/null 2>&1
sleep 1

# 3. Remove the app and its settings ------------------------------------------
say "Removing the app..."
rm -rf "$INSTALLED_APP"
rm -rf "$SUPPORT_DIR"
rm -rf "$LOG_DIR"

say ""
line
if [[ -d "$INSTALLED_APP" ]]; then
  say "  Ordo could not be removed automatically."
  say "  Open your Applications folder and drag \"Ordo\" to the Bin."
else
  say "  Done. Ordo has been removed."
  say ""
  say "  The Ordo folder is still on your Mac. To put the app back,"
  say "  open that folder and double-click the file called install.command."
fi
line
say ""
say "You can close this window now (press Return)."
read -r _
