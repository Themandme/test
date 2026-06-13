#!/usr/bin/env bash
# One-command project bootstrap. Requires macOS + Xcode (14, 15, or 16).
# Generates the Xcode project from project.yml, then builds and tests.
#
# We pin XcodeGen 2.42.0 (downloaded, not from Homebrew) on purpose: Homebrew's latest
# XcodeGen writes the Xcode-16.3 project format (objectVersion 77), which fails to open
# in older Xcode with "future Xcode project file format (77)". 2.42.0 writes
# objectVersion 56, which opens in Xcode 14/15/16.
set -euo pipefail
cd "$(dirname "$0")"

XCODEGEN_VERSION="2.42.0"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ Downloading XcodeGen $XCODEGEN_VERSION"
curl -fsSL -o "$WORK/xcodegen.zip" \
  "https://github.com/yonaskolb/XcodeGen/releases/download/$XCODEGEN_VERSION/xcodegen.zip"
unzip -q "$WORK/xcodegen.zip" -d "$WORK/xcodegen"
XCODEGEN="$(find "$WORK/xcodegen" -type f -name xcodegen -perm +111 | head -1)"
test -n "$XCODEGEN" || { echo "xcodegen binary not found in download"; exit 1; }

echo "→ Generating SeniorDirectory.xcodeproj from project.yml"
rm -rf SeniorDirectory.xcodeproj    # remove any stale (possibly newer-format) project
"$XCODEGEN" generate

echo "→ Resolving Swift package dependencies (GRDB)"
xcodebuild -resolvePackageDependencies -project SeniorDirectory.xcodeproj -scheme SeniorDirectory >/dev/null

echo "→ Building + testing on an iOS Simulator"
xcodebuild test \
  -project SeniorDirectory.xcodeproj \
  -scheme SeniorDirectory \
  -destination 'platform=iOS Simulator,name=iPhone 15,OS=latest' \
  | tail -40

echo "✅ Done. Open SeniorDirectory.xcodeproj in Xcode to run the app."
