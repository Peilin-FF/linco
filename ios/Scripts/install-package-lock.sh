#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios_root="$(cd "$script_dir/.." && pwd)"
project="$ios_root/Linco.xcodeproj"
source_lock="$ios_root/Package.resolved"
destination_dir="$project/project.xcworkspace/xcshareddata/swiftpm"
destination_lock="$destination_dir/Package.resolved"

python3 "$script_dir/verify-package-lock.py"
if [[ ! -d "$project" ]]; then
  echo "error: generate $project with XcodeGen before installing the package lock" >&2
  exit 1
fi

install -d -m 0755 "$destination_dir"
install -m 0644 "$source_lock" "$destination_lock"
cmp -s "$source_lock" "$destination_lock"
echo "Installed verified SwiftPM lock at $destination_lock"
