#!/usr/bin/env bash

set -euo pipefail

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required but was not found."
  exit 1
fi

home_dir=${HOME:-.}
profiles=()
profile_platforms=()
profile_roots=()

append_unique() {
  local value=$1
  local existing
  [ -n "$value" ] || return 0
  for existing in "${profile_roots[@]-}"; do
    [ "$existing" = "$value" ] && return 0
  done
  profile_roots+=("$value")
}

normalize_windows_path() {
  local path=$1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -u "$path" 2>/dev/null || true
  elif command -v wslpath >/dev/null 2>&1; then
    wslpath -u "$path" 2>/dev/null || true
  elif [[ "$path" =~ ^([A-Za-z]):[\\\\](.*)$ ]]; then
    local drive=${BASH_REMATCH[1],,}
    local rest=${BASH_REMATCH[2]//\\//}
    printf '/mnt/%s/%s\n' "$drive" "$rest"
  else
    printf '%s\n' "$path"
  fi
}

collect_profiles() {
  local platform=$1
  local profile_root database profile_dir existing duplicate
  local -a found=()

  for profile_root in "${profile_roots[@]-}"; do
    [ -d "$profile_root" ] || continue
    while IFS= read -r database; do
      [ -n "$database" ] || continue
      profile_dir=${database%/places.sqlite}
      duplicate=0
      for existing in "${found[@]-}"; do
        if [ "$existing" = "$profile_dir" ]; then
          duplicate=1
          break
        fi
      done
      [ "$duplicate" -eq 0 ] && found+=("$profile_dir")
    done < <(find "$profile_root" -type f -name places.sqlite -print 2>/dev/null)
  done

  if [ "${#found[@]}" -gt 0 ]; then
    profiles=("${found[@]}")
    for profile_dir in "${profiles[@]}"; do
      profile_platforms+=("$platform")
    done
    return 0
  fi
  return 1
}

scan_macos() {
  local app_path found_app=0
  local -a app_paths=(
    "/Applications/Firefox Nightly.app"
    "$home_dir/Applications/Firefox Nightly.app"
    "/Applications/Firefox.app"
    "$home_dir/Applications/Firefox.app"
    "/Applications/Firefox Developer Edition.app"
    "$home_dir/Applications/Firefox Developer Edition.app"
  )

  echo "Checking macOS Firefox locations"
  for app_path in "${app_paths[@]-}"; do
    if [ -d "$app_path" ]; then
      echo "  found application: $app_path"
      found_app=1
    fi
  done
  [ "$found_app" -eq 1 ] || echo "  no common macOS Firefox application found"

  profile_roots=()
  append_unique "$home_dir/Library/Application Support/Firefox/Profiles"
  append_unique "$home_dir/Library/Application Support/Firefox Nightly/Profiles"
  append_unique "$home_dir/Library/Application Support/Firefox Developer Edition/Profiles"
  append_unique "$home_dir/Library/Application Support/Firefox Beta/Profiles"
  collect_profiles macOS
}

scan_windows() {
  local app_path program_files program_files_x86 appdata localappdata userprofile
  local profile_base found_app=0
  local -a app_paths=()

  program_files=$(printenv PROGRAMFILES 2>/dev/null || true)
  program_files_x86=$(printenv 'PROGRAMFILES(X86)' 2>/dev/null || true)
  appdata=$(printenv APPDATA 2>/dev/null || true)
  localappdata=$(printenv LOCALAPPDATA 2>/dev/null || true)
  userprofile=$(printenv USERPROFILE 2>/dev/null || true)

  for program_files in "$program_files" "$program_files_x86"; do
    [ -n "$program_files" ] || continue
    app_paths+=(
      "$(normalize_windows_path "$program_files/Mozilla Firefox Nightly")"
      "$(normalize_windows_path "$program_files/Mozilla Firefox")"
    )
  done

  echo "Checking Windows Firefox locations"
  for app_path in "${app_paths[@]-}"; do
    if [ -d "$app_path" ]; then
      echo "  found application: $app_path"
      found_app=1
    fi
  done
  [ "$found_app" -eq 1 ] || echo "  no common Windows Firefox application found"

  profile_roots=()
  local -a profile_bases=("$appdata" "$localappdata")
  [ -n "$userprofile" ] && profile_bases+=("$userprofile/AppData/Roaming")
  for profile_base in "${profile_bases[@]}"; do
    [ -n "$profile_base" ] || continue
    profile_base=$(normalize_windows_path "$profile_base")
    append_unique "$profile_base/Mozilla/Firefox/Profiles"
    append_unique "$profile_base/Mozilla/Firefox Nightly/Profiles"
    append_unique "$profile_base/Mozilla/Firefox Developer Edition/Profiles"
  done
  collect_profiles Windows
}

scan_ubuntu() {
  local app_path found_app=0
  local -a app_paths=(
    "/usr/bin/firefox"
    "/snap/bin/firefox"
    "/opt/firefox/firefox"
    "/usr/local/bin/firefox"
  )

  echo "Checking Ubuntu Firefox locations"
  for app_path in "${app_paths[@]}"; do
    if [ -e "$app_path" ]; then
      echo "  found application: $app_path"
      found_app=1
    fi
  done
  [ "$found_app" -eq 1 ] || echo "  no common Ubuntu Firefox application found"

  profile_roots=()
  append_unique "$home_dir/.mozilla/firefox"
  append_unique "$home_dir/snap/firefox/common/.mozilla/firefox"
  append_unique "$home_dir/.var/app/org.mozilla.firefox/.mozilla/firefox"
  append_unique "$home_dir/.var/app/org.mozilla.firefoxnightly/.mozilla/firefox"
  collect_profiles Ubuntu
}

echo "Firefox profile search"
if ! scan_macos; then
  if ! scan_windows; then
    scan_ubuntu || true
  fi
fi

if [ "${#profiles[@]}" -eq 0 ]; then
  echo
  echo "No profiles containing places.sqlite were found in the common locations."
  exit 1
fi

echo
echo "Firefox profiles"
profile_number=1
for profile_dir in "${profiles[@]}"; do
  database="$profile_dir/places.sqlite"
  places_count=$(sqlite3 "file:${database}?mode=ro" \
    "SELECT COUNT(*) FROM moz_places;" 2>/dev/null || echo "unavailable")
  database_size=$(du -h "$database" | awk '{print $1}')
  latest_visit=$(sqlite3 -separator $'\t' "file:${database}?mode=ro" \
    "SELECT datetime(h.visit_date / 1000000, 'unixepoch', 'localtime'), replace(replace(ifnull(p.title, ''), char(9), ' '), char(10), ' '), p.url FROM moz_historyvisits h JOIN moz_places p ON p.id = h.place_id WHERE h.visit_date IS NOT NULL ORDER BY h.visit_date DESC LIMIT 1;" \
    2>/dev/null || true)

  latest_date=""
  latest_title=""
  latest_url=""
  if [ -n "$latest_visit" ]; then
    latest_date=$(printf '%s\n' "$latest_visit" | cut -f1)
    latest_title=$(printf '%s\n' "$latest_visit" | cut -f2)
    latest_url=$(printf '%s\n' "$latest_visit" | cut -f3)
  fi

  echo "[$profile_number] ${profile_platforms[$((profile_number - 1))]} — $profile_dir"
  echo "    places rows: $places_count"
  echo "    places.sqlite: $database_size"
  if [ -n "$latest_url" ]; then
    echo "    latest visit: $latest_date — ${latest_title:-[untitled]}"
    echo "                  $latest_url"
  else
    echo "    latest visit: none"
  fi
  profile_number=$((profile_number + 1))
done

echo
printf "Select a profile number, or q to quit: "
read -r selection
if [ "$selection" = "q" ] || [ "$selection" = "Q" ]; then
  exit 0
fi
if ! [[ "$selection" =~ ^[0-9]+$ ]] || [ "$selection" -lt 1 ] || [ "$selection" -ge "$profile_number" ]; then
  echo "Invalid profile selection."
  exit 1
fi

selected_profile="${profiles[$((selection - 1))]}"
firefox_running=0
if command -v pgrep >/dev/null 2>&1 && pgrep -f '[Ff]irefox' >/dev/null 2>&1; then
  firefox_running=1
elif command -v tasklist.exe >/dev/null 2>&1 && tasklist.exe 2>/dev/null | grep -qi 'firefox.exe'; then
  firefox_running=1
fi
if [ "$firefox_running" -eq 1 ]; then
  echo
  echo "Firefox appears to be running. Close Firefox before copying a profile."
  printf "Continue anyway? [y/N] "
  read -r continue_copy
  case "$continue_copy" in
    y|Y) ;;
    *) echo "Copy cancelled."; exit 1 ;;
  esac
fi

default_destination="$home_dir/tmp/nightly-profile-copies"
echo
printf "Destination directory [%s]: " "$default_destination"
read -r destination
destination=${destination:-$default_destination}
case "$destination" in
  "~") destination="$home_dir" ;;
  "~/"*) destination="$home_dir/${destination#~/}" ;;
esac

mkdir -p "$destination"
copy_path="$destination/nightly-profile-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$copy_path"

if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude='parent.lock' \
    --exclude='.parentlock' \
    --exclude='lock' \
    --exclude='cache2/' \
    --exclude='startupCache/' \
    "$selected_profile/" "$copy_path/"
else
  cp -a "$selected_profile/." "$copy_path/"
  rm -rf "$copy_path/cache2" "$copy_path/startupCache"
  rm -f "$copy_path/parent.lock" "$copy_path/.parentlock" "$copy_path/lock"
fi

echo
echo "Copied profile to: $copy_path"
echo "Run this checkout with the copy using:"
echo "  ./mach run --noprofile -- -profile '$copy_path'"
