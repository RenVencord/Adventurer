"""
build_stub.py
Compiles stub.py into a standalone stub.exe using PyInstaller and places it
in the user's ~/.Adventurer/ directory.  Run this once before (or on first
launch of) the main Adventurer application.

Usage:
    python build_stub.py
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

APPDATA_DIR = Path.home() / ".Adventurer"
STUB_SOURCE = Path(__file__).parent / "stub.py"


def main():
    APPDATA_DIR.mkdir(parents=True, exist_ok=True)

    if not STUB_SOURCE.exists():
        print(f"ERROR: stub.py not found at {STUB_SOURCE}")
        sys.exit(1)

    target_name = "stub.exe" if sys.platform == "win32" else "stub"
    target_path = APPDATA_DIR / target_name

    if target_path.exists():
        print(f"Stub already exists at {target_path} — skipping build.")
        return

    build_dir = Path(__file__).parent / "build_stub_tmp"
    dist_dir = build_dir / "dist"

    print(f"Building stub from {STUB_SOURCE} ...")
    try:
        subprocess.run(
            [
                sys.executable, "-m", "PyInstaller",
                "--onefile",
                "--windowed",
                "--name", "stub",
                "--distpath", str(dist_dir),
                "--workpath", str(build_dir / "work"),
                "--specpath", str(build_dir),
                "--noconfirm",
                str(STUB_SOURCE),
            ],
            check=True,
        )

        built = dist_dir / target_name
        if not built.exists():
            print(f"ERROR: Expected built stub at {built} but it was not found.")
            sys.exit(1)

        shutil.copy2(built, target_path)
        print(f"Stub installed to {target_path}")
    finally:
        # Clean up temporary build artifacts
        if build_dir.exists():
            shutil.rmtree(build_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
