#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FINAL_OUT_DIR="$ROOT_DIR/helpers/macos"
STAGE_OUT_DIR="$ROOT_DIR/helpers/.macos-staging-$$"
OUT_DIR="$STAGE_OUT_DIR"
BIN_DIR="$OUT_DIR/bin"
LIB_DIR="$OUT_DIR/Libraries"
LIBRAW_DIR="$OUT_DIR/libraw"
EXIF_LIB_DIR="$OUT_DIR/exiftool-lib/perl5"

cleanup_stage_dir() {
  if [[ -d "$STAGE_OUT_DIR" ]]; then
    rm -rf "$STAGE_OUT_DIR"
  fi
}

trap cleanup_stage_dir EXIT

must_exist() {
  local target="$1"
  local label="$2"
  if [[ ! -e "$target" ]]; then
    echo "Missing $label at $target" >&2
    exit 1
  fi
}

pick_first_existing() {
  for candidate in "$@"; do
    if [[ -e "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

resolve_path() {
  local target="$1"
  local max_depth=20

  if [[ ! -e "$target" && ! -L "$target" ]]; then
    return 1
  fi

  while [[ -L "$target" && "$max_depth" -gt 0 ]]; do
    local link
    link="$(readlink "$target")"
    if [[ "$link" = /* ]]; then
      target="$link"
    else
      target="$(cd "$(dirname "$target")" && pwd)/$link"
    fi
    max_depth=$((max_depth - 1))
  done

  echo "$(cd "$(dirname "$target")" && pwd)/$(basename "$target")"
}

is_macho_file() {
  local target="$1"
  if file -b "$target" 2>/dev/null | grep -q "Mach-O"; then
    return 0
  fi
  return 1
}

collect_macho_files() {
  local scan_dir="$1"
  find "$scan_dir" -type f -print0 | while IFS= read -r -d '' file_path; do
    if is_macho_file "$file_path"; then
      echo "$file_path"
    fi
  done
}

clear_quarantine_attrs() {
  local target="$1"
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$target" >/dev/null 2>&1 || true
  fi
}

normalize_loader_paths() {
  local binary dep dep_base target_path

  for binary in "$BIN_DIR"/*; do
    if [[ ! -f "$binary" ]] || ! is_macho_file "$binary"; then
      continue
    fi
    chmod u+w "$binary" || true
    while IFS= read -r dep; do
      dep_base="$(basename "$dep")"
      if [[ -f "$LIB_DIR/$dep_base" ]]; then
        target_path="@executable_path/../Libraries/$dep_base"
      elif [[ -f "$LIBRAW_DIR/$dep_base" ]]; then
        target_path="@executable_path/../libraw/$dep_base"
      else
        continue
      fi
      if [[ "$dep" != "$target_path" ]]; then
        install_name_tool -change "$dep" "$target_path" "$binary" || true
      fi
    done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
  done

  for binary in "$LIB_DIR"/*.dylib "$LIBRAW_DIR"/*.dylib; do
    if [[ ! -f "$binary" ]] || ! is_macho_file "$binary"; then
      continue
    fi
    chmod u+w "$binary" || true
    install_name_tool -id "@loader_path/$(basename "$binary")" "$binary" || true
    while IFS= read -r dep; do
      dep_base="$(basename "$dep")"
      if [[ -f "$LIB_DIR/$dep_base" || -f "$LIBRAW_DIR/$dep_base" ]]; then
        target_path="@loader_path/$dep_base"
      else
        continue
      fi
      if [[ "$dep" != "$target_path" ]]; then
        install_name_tool -change "$dep" "$target_path" "$binary" || true
      fi
    done < <(otool -L "$binary" | tail -n +2 | awk '{print $1}')
  done
}

sign_bundle_macho() {
  if ! command -v codesign >/dev/null 2>&1; then
    echo "codesign is not available; skipping helper code signing." >&2
    return 0
  fi

  local sign_target sign_failed=0
  while IFS= read -r sign_target; do
    [[ -n "$sign_target" ]] || continue
    chmod u+w "$sign_target" || true
    if ! codesign --force --sign - --timestamp=none "$sign_target" >/dev/null 2>&1; then
      echo "codesign failed for $sign_target" >&2
      sign_failed=1
    fi
  done < <(collect_macho_files "$OUT_DIR" | grep '\.dylib$' | sort)

  while IFS= read -r sign_target; do
    [[ -n "$sign_target" ]] || continue
    chmod u+w "$sign_target" || true
    if ! codesign --force --sign - --timestamp=none "$sign_target" >/dev/null 2>&1; then
      echo "codesign failed for $sign_target" >&2
      sign_failed=1
    fi
  done < <(collect_macho_files "$OUT_DIR" | grep -v '\.dylib$' | sort)

  if [[ "$sign_failed" -ne 0 ]]; then
    echo "Helper signing failed." >&2
    exit 1
  fi
}

verify_codesign_bundle() {
  if ! command -v codesign >/dev/null 2>&1; then
    return 0
  fi
  local verify_target
  while IFS= read -r verify_target; do
    [[ -n "$verify_target" ]] || continue
    if ! codesign --verify --verbose=2 "$verify_target" >/dev/null 2>&1; then
      echo "codesign verification failed for $verify_target" >&2
      exit 1
    fi
  done < <(collect_macho_files "$OUT_DIR" | sort)
}

verify_no_quarantine_attrs() {
  if ! command -v xattr >/dev/null 2>&1; then
    return 0
  fi

  local quarantine_hits
  quarantine_hits="$(xattr -r "$OUT_DIR" 2>/dev/null | grep 'com.apple.quarantine' || true)"
  if [[ -n "$quarantine_hits" ]]; then
    echo "Quarantine attributes are still present in staged helpers:" >&2
    echo "$quarantine_hits" >&2
    exit 1
  fi
}

verify_no_external_helper_deps() {
  local file_path dep has_error=0
  while IFS= read -r file_path; do
    [[ -n "$file_path" ]] || continue
    while IFS= read -r dep; do
      case "$dep" in
        /System/*|/usr/lib/*|/Library/Apple/*|@executable_path/*|@loader_path/*)
          ;;
        /Applications/Hugin/*|/opt/homebrew/*|/usr/local/*|@rpath/*)
          echo "Unbundled dependency found in $file_path: $dep" >&2
          has_error=1
          ;;
      esac
    done < <(otool -L "$file_path" | tail -n +2 | awk '{print $1}')
  done < <(collect_macho_files "$OUT_DIR")

  if [[ "$has_error" -ne 0 ]]; then
    echo "Helper dylib dependency validation failed." >&2
    exit 1
  fi
}

run_helper_smoke_check() {
  local label="$1"
  shift

  local smoke_log
  smoke_log="$(mktemp)"

  "$@" >"$smoke_log" 2>&1 &
  local smoke_pid=$!
  local timeout_seconds=12
  local elapsed=0

  while kill -0 "$smoke_pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
      kill -TERM "$smoke_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$smoke_pid" 2>/dev/null || true
      echo "Helper smoke check timed out for $label" >&2
      sed -n '1,80p' "$smoke_log" >&2 || true
      rm -f "$smoke_log"
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$smoke_pid" || true

  if grep -Eiq "Library not loaded|image not found|code signature|not valid for use in process|dyld" "$smoke_log"; then
    echo "Helper smoke check failed for $label" >&2
    sed -n '1,80p' "$smoke_log" >&2 || true
    rm -f "$smoke_log"
    exit 1
  fi
  rm -f "$smoke_log"
}

run_helper_smoke_checks() {
  run_helper_smoke_check "enfuse" "$BIN_DIR/enfuse" --version
  run_helper_smoke_check "align_image_stack" "$BIN_DIR/align_image_stack" --help
  run_helper_smoke_check "dcraw_emu" "$BIN_DIR/dcraw_emu" -v
  run_helper_smoke_check "exiftool" "$BIN_DIR/exiftool" -ver
}

echo "Staging helper bundle in $STAGE_OUT_DIR"
rm -rf "$STAGE_OUT_DIR"
mkdir -p "$BIN_DIR" "$LIB_DIR" "$LIBRAW_DIR" "$EXIF_LIB_DIR"

ACE_HELPER_SRC="$ROOT_DIR/bin/ace-dng-sdk-helper"
must_exist "$ACE_HELPER_SRC" "ace-dng-sdk-helper source"
cp "$ACE_HELPER_SRC" "$BIN_DIR/ace-dng-sdk-helper"

ENFUSE_SRC="$(pick_first_existing \
  /Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/enfuse \
  /Applications/Hugin/HuginStitchProject.app/Contents/MacOS/enfuse \
  /Applications/Hugin/Hugin.app/Contents/MacOS/enfuse \
  /opt/homebrew/bin/enfuse \
  /usr/local/bin/enfuse || true)"
must_exist "$ENFUSE_SRC" "enfuse binary"
cp "$ENFUSE_SRC" "$BIN_DIR/enfuse"

ALIGN_SRC="$(pick_first_existing \
  /Applications/Hugin/Hugin.app/Contents/MacOS/align_image_stack \
  /Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/align_image_stack \
  /Applications/Hugin/HuginStitchProject.app/Contents/MacOS/align_image_stack \
  /opt/homebrew/bin/align_image_stack \
  /usr/local/bin/align_image_stack || true)"
must_exist "$ALIGN_SRC" "align_image_stack binary"
cp "$ALIGN_SRC" "$BIN_DIR/align_image_stack"

HUGIN_LIB_SRC_1="/Applications/Hugin/Hugin.app/Contents/Libraries"
HUGIN_LIB_SRC_2="/Applications/Hugin/PTBatcherGUI.app/Contents/Libraries"
HUGIN_LIB_SRC_3="/Applications/Hugin/HuginStitchProject.app/Contents/Libraries"
HUGIN_LIB_SOURCES=()
for candidate in "$HUGIN_LIB_SRC_1" "$HUGIN_LIB_SRC_2" "$HUGIN_LIB_SRC_3"; do
  if [[ -d "$candidate" ]]; then
    HUGIN_LIB_SOURCES+=("$candidate")
  fi
done

if [[ "${#HUGIN_LIB_SOURCES[@]}" -eq 0 ]]; then
  echo "Missing Hugin library directory. Checked: $HUGIN_LIB_SRC_1, $HUGIN_LIB_SRC_2, $HUGIN_LIB_SRC_3" >&2
  exit 1
fi

for lib_src in "${HUGIN_LIB_SOURCES[@]}"; do
  cp -R "$lib_src"/. "$LIB_DIR"/
done

DCRAW_SRC="$(pick_first_existing /opt/homebrew/bin/dcraw_emu /usr/local/bin/dcraw_emu || true)"
must_exist "$DCRAW_SRC" "dcraw_emu binary"
cp "$DCRAW_SRC" "$BIN_DIR/dcraw_emu"

LIBRAW_DYLIB="$(pick_first_existing /opt/homebrew/opt/libraw/lib/libraw.24.dylib /usr/local/opt/libraw/lib/libraw.24.dylib || true)"
LIBOMP_DYLIB="$(pick_first_existing /opt/homebrew/opt/libomp/lib/libomp.dylib /usr/local/opt/libomp/lib/libomp.dylib || true)"
LIBJPEG_DYLIB="$(pick_first_existing /opt/homebrew/opt/jpeg-turbo/lib/libjpeg.8.dylib /usr/local/opt/jpeg-turbo/lib/libjpeg.8.dylib || true)"
LIBLCMS_DYLIB="$(pick_first_existing /opt/homebrew/opt/little-cms2/lib/liblcms2.2.dylib /usr/local/opt/little-cms2/lib/liblcms2.2.dylib || true)"
must_exist "$LIBRAW_DYLIB" "libraw.24.dylib"
must_exist "$LIBOMP_DYLIB" "libomp.dylib"
must_exist "$LIBJPEG_DYLIB" "libjpeg.8.dylib"
must_exist "$LIBLCMS_DYLIB" "liblcms2.2.dylib"

cp "$LIBRAW_DYLIB" "$LIBRAW_DIR/libraw.24.dylib"
cp "$LIBOMP_DYLIB" "$LIBRAW_DIR/libomp.dylib"
cp "$LIBJPEG_DYLIB" "$LIBRAW_DIR/libjpeg.8.dylib"
cp "$LIBLCMS_DYLIB" "$LIBRAW_DIR/liblcms2.2.dylib"

chmod +x "$BIN_DIR/ace-dng-sdk-helper" "$BIN_DIR/enfuse" "$BIN_DIR/align_image_stack" "$BIN_DIR/dcraw_emu"
chmod u+w "$BIN_DIR/dcraw_emu" "$LIBRAW_DIR"/*.dylib

# Patch LibRaw toolchain to use bundled dylibs.
install_name_tool -change "/opt/homebrew/Cellar/libraw/0.22.0_1/lib/libraw.24.dylib" "@executable_path/../libraw/libraw.24.dylib" "$BIN_DIR/dcraw_emu" || true
install_name_tool -change "/opt/homebrew/opt/libraw/lib/libraw.24.dylib" "@executable_path/../libraw/libraw.24.dylib" "$BIN_DIR/dcraw_emu" || true
install_name_tool -change "/opt/homebrew/opt/libomp/lib/libomp.dylib" "@executable_path/../libraw/libomp.dylib" "$BIN_DIR/dcraw_emu" || true
install_name_tool -change "/usr/local/opt/libraw/lib/libraw.24.dylib" "@executable_path/../libraw/libraw.24.dylib" "$BIN_DIR/dcraw_emu" || true
install_name_tool -change "/usr/local/opt/libomp/lib/libomp.dylib" "@executable_path/../libraw/libomp.dylib" "$BIN_DIR/dcraw_emu" || true

install_name_tool -id "@loader_path/libraw.24.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -id "@loader_path/libomp.dylib" "$LIBRAW_DIR/libomp.dylib" || true
install_name_tool -id "@loader_path/libjpeg.8.dylib" "$LIBRAW_DIR/libjpeg.8.dylib" || true
install_name_tool -id "@loader_path/liblcms2.2.dylib" "$LIBRAW_DIR/liblcms2.2.dylib" || true

install_name_tool -change "/opt/homebrew/opt/libomp/lib/libomp.dylib" "@loader_path/libomp.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -change "/opt/homebrew/opt/jpeg-turbo/lib/libjpeg.8.dylib" "@loader_path/libjpeg.8.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -change "/opt/homebrew/opt/little-cms2/lib/liblcms2.2.dylib" "@loader_path/liblcms2.2.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -change "/usr/local/opt/libomp/lib/libomp.dylib" "@loader_path/libomp.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -change "/usr/local/opt/jpeg-turbo/lib/libjpeg.8.dylib" "@loader_path/libjpeg.8.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true
install_name_tool -change "/usr/local/opt/little-cms2/lib/liblcms2.2.dylib" "@loader_path/liblcms2.2.dylib" "$LIBRAW_DIR/libraw.24.dylib" || true

EXIFTOOL_BIN="$(command -v exiftool || true)"
must_exist "$EXIFTOOL_BIN" "exiftool command"
EXIFTOOL_SCRIPT_SRC="$(resolve_path "$EXIFTOOL_BIN")"
EXIFTOOL_CELLAR_DIR="$(dirname "$(dirname "$EXIFTOOL_SCRIPT_SRC")")"
EXIFTOOL_LIB_ALT="$(dirname "$EXIFTOOL_SCRIPT_SRC")/../lib/perl5"
EXIFTOOL_LIB_SRC="$(pick_first_existing \
  "$EXIFTOOL_CELLAR_DIR/libexec/lib/perl5" \
  "$EXIFTOOL_LIB_ALT" || true)"
must_exist "$EXIFTOOL_SCRIPT_SRC" "exiftool script"
must_exist "$EXIFTOOL_LIB_SRC" "exiftool perl library directory"

cp "$EXIFTOOL_SCRIPT_SRC" "$BIN_DIR/exiftool-real"
cp -R "$EXIFTOOL_LIB_SRC"/. "$EXIF_LIB_DIR"/

# Ensure packaged signing can read and rewrite signatures on copied files.
chmod -R u+rwX,go+rX "$OUT_DIR"

cat > "$BIN_DIR/exiftool" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PERL_BIN="/usr/bin/perl"
PERL_LIB="$SCRIPT_DIR/../exiftool-lib/perl5"
exec "$PERL_BIN" -I"$PERL_LIB" -I"$PERL_LIB/darwin-thread-multi-2level" "$SCRIPT_DIR/exiftool-real" "$@"
EOF
chmod +x "$BIN_DIR/exiftool" "$BIN_DIR/exiftool-real"

normalize_loader_paths
clear_quarantine_attrs "$OUT_DIR"
sign_bundle_macho
verify_codesign_bundle
verify_no_external_helper_deps
run_helper_smoke_checks
verify_no_quarantine_attrs

echo "Promoting staged helper bundle to $FINAL_OUT_DIR"
BACKUP_OUT_DIR="$ROOT_DIR/helpers/.macos-backup-$$"
rm -rf "$BACKUP_OUT_DIR"
if [[ -d "$FINAL_OUT_DIR" ]]; then
  mv "$FINAL_OUT_DIR" "$BACKUP_OUT_DIR"
fi

if mv "$STAGE_OUT_DIR" "$FINAL_OUT_DIR"; then
  rm -rf "$BACKUP_OUT_DIR"
else
  echo "Failed to promote staged helpers to final location." >&2
  rm -rf "$FINAL_OUT_DIR"
  if [[ -d "$BACKUP_OUT_DIR" ]]; then
    mv "$BACKUP_OUT_DIR" "$FINAL_OUT_DIR"
  fi
  exit 1
fi

trap - EXIT

OUT_DIR="$FINAL_OUT_DIR"
BIN_DIR="$OUT_DIR/bin"

echo "Staged helper binaries:"
echo "  - $BIN_DIR/ace-dng-sdk-helper"
echo "  - $BIN_DIR/dcraw_emu"
echo "  - $BIN_DIR/enfuse"
echo "  - $BIN_DIR/align_image_stack"
echo "  - $BIN_DIR/exiftool"
