#!/bin/sh
# Installs (or removes) the LaunchAgent that starts J.A.R.V.I.S.'s scheduled run at 9:00 and 21:00 every day.
#   sh scripts/schedule.sh            install / update (uses the packaged app in release/)
#   sh scripts/schedule.sh remove     uninstall
#   sh scripts/schedule.sh now        start a scheduled run right away (same as launchd does)
# `open -n` hands --scheduled-run to the app: if J.A.R.V.I.S. is already open, that copy runs it; if not, the app starts
# without a window and quits when the run ends. A run missed while the Mac slept starts when it wakes.
set -e
LABEL=local.jarvis.pipeline
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cd "$(dirname "$0")/.."
APP="$(pwd)/release/mac-arm64/J.A.R.V.I.S.app"
[ -d "$APP" ] || APP="$(pwd)/release/mac/J.A.R.V.I.S.app"

case "$1" in
  remove)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "Removed $LABEL"; exit 0 ;;
  now)
    exec /usr/bin/open -n -g -a "$APP" --args --scheduled-run ;;
esac

[ -d "$APP" ] || { echo "No packaged app found. Run: npm run package"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string><string>-n</string><string>-g</string><string>-a</string><string>$APP</string>
    <string>--args</string><string>--scheduled-run</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>/tmp/$LABEL.log</string>
  <key>StandardErrorPath</key><string>/tmp/$LABEL.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL: runs $APP at 9:00 and 21:00."
