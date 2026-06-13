#!/usr/bin/env bash
# One-command project bootstrap. Requires macOS + Xcode.
# Generates the Xcode project from project.yml, then builds and tests.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen not found. Install it with:  brew install xcodegen"
  echo "(or:  mint install yonaskolb/XcodeGen)"
  exit 1
fi

echo "→ Generating SeniorDirectory.xcodeproj from project.yml"
xcodegen generate

echo "→ Resolving Swift package dependencies (GRDB)"
xcodebuild -resolvePackageDependencies -project SeniorDirectory.xcodeproj -scheme SeniorDirectory >/dev/null

echo "→ Building + testing on an iOS Simulator"
xcodebuild test \
  -project SeniorDirectory.xcodeproj \
  -scheme SeniorDirectory \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  | tail -40

echo "✅ Done. Open SeniorDirectory.xcodeproj in Xcode to run the app."
