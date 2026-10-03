"""
native student client - watches your file(s) and copies teacher edits
straight to your clipboard. this exists because the browser version
can't auto-copy to clipboard from a background tab (tried it, browsers
just block it for security reasons). so this is a plain python script
instead, runs as a real process so it doesn't have that restriction.

usage:
    pip install requests pyperclip plyer
    python mockingbird_student.py yourfile.py

can pass multiple files too:
    python mockingbird_student.py file1.py file2.py

need to switch to a different classroom, or joined the wrong one?
    python mockingbird_student.py yourfile.py --reset
(this clears the saved name/classroom and asks again on this run)

first run asks for your name + the classroom code, after that it just
remembers you (saved in .mockingbird_signature etc in this folder)
"""

import sys
import os
import time
import requests
import pyperclip

try:
    from plyer import notification
    HAVE_TOAST = True
except ImportError:
    HAVE_TOAST = False

# points at localhost for now during dev - once the backend is deployed
# (render/railway/whatever), change this default to the real URL, e.g.
# "https://mockingbird-backend.onrender.com/api" so students don't need
# to set anything themselves. can still override with an env var if
# someone needs to point at a different backend for testing.
API_BASE = os.getenv("MOCKINGBIRD_API_BASE", "https://mocking-birdd.onrender.com/api")
POLL_SECONDS = 1
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SIGNATURE_FILE = os.path.join(SCRIPT_DIR, ".mockingbird_signature")
NAME_FILE = os.path.join(SCRIPT_DIR, ".mockingbird_name")
CLASSROOM_FILE = os.path.join(SCRIPT_DIR, ".mockingbird_classroom")


def toast(title, message):
    if not HAVE_TOAST:
        return
    try:
        notification.notify(title=title, message=message, timeout=4)
    except Exception:
        pass  # notifications aren't critical, just skip if it fails


def get_or_create_signature():
    if os.path.exists(SIGNATURE_FILE):
        with open(SIGNATURE_FILE, "r") as f:
            sig = f.read().strip()
        if sig:
            saved_name = ""
            saved_code = ""
            if os.path.exists(NAME_FILE):
                with open(NAME_FILE, "r") as f:
                    saved_name = f.read().strip()
            if os.path.exists(CLASSROOM_FILE):
                with open(CLASSROOM_FILE, "r") as f:
                    saved_code = f.read().strip()
            label = f"{saved_name} — {saved_code}" if saved_name else sig
            print(f"Reusing existing session: {sig} ({label})")
            return sig

    # first time running - need name + classroom code
    name = input("Apna naam ya roll number likho: ").strip()
    classroom_code = input("Teacher ka classroom code likho: ").strip().upper()

    params = {"role": "student", "classroom_code": classroom_code}
    if name:
        params["name"] = name

    resp = requests.post(f"{API_BASE}/register", params=params, timeout=10)
    if resp.status_code == 404:
        print("❌ Ye classroom code nahi mila — teacher se sahi code confirm karo.")
        sys.exit(1)
    if resp.status_code == 400:
        print(f"❌ {resp.json().get('detail', 'Registration failed')}")
        sys.exit(1)
    resp.raise_for_status()
    sig = resp.json()["signature"]

    with open(SIGNATURE_FILE, "w") as f:
        f.write(sig)
    if name:
        with open(NAME_FILE, "w") as f:
            f.write(name)
    with open(CLASSROOM_FILE, "w") as f:
        f.write(classroom_code)

    print(f"Registered new session: {sig} ({name} — {classroom_code})")
    return sig


def upload_current_content(signature, filepath, content):
    filename = os.path.basename(filepath)
    files = {"file": (filename, content.encode("utf-8"))}
    resp = requests.post(
        f"{API_BASE}/upload",
        params={"signature": signature},
        files=files,
        timeout=15,
    )
    resp.raise_for_status()
    result = resp.json()
    if result.get("success") is False:
        print(f"  ⚠ upload reported an error: {result.get('error')}")


def reset_saved_session():
    # wipes the saved identity so the next call to get_or_create_signature()
    # asks fresh - for when a student needs to join a different classroom
    # (new semester, joined the wrong code, etc)
    for f in (SIGNATURE_FILE, NAME_FILE, CLASSROOM_FILE):
        if os.path.exists(f):
            os.remove(f)
    print("Cleared saved session. You'll be asked for your name and classroom code again.\n")


def main():
    if len(sys.argv) < 2:
        print("Usage: python mockingbird_student.py path\\to\\file1.py [path\\to\\file2.py ...] [--reset]")
        sys.exit(1)

    args = sys.argv[1:]
    if "--reset" in args:
        args.remove("--reset")
        reset_saved_session()

    if not args:
        print("Usage: python mockingbird_student.py path\\to\\file1.py [path\\to\\file2.py ...] [--reset]")
        sys.exit(1)

    # everything left = a file to watch. lets one student track more
    # than one file under the same session
    watched_paths = args
    for p in watched_paths:
        if not os.path.exists(p):
            print(f"File not found: {p}")
            sys.exit(1)

    signature = get_or_create_signature()

    print(f"Connected to backend: {API_BASE}")
    for p in watched_paths:
        print(f"Watching '{p}' for changes")
    print(f"Polling for teacher pushes every {POLL_SECONDS}s")
    print("Keep this running in the background — Ctrl+C to stop.\n")

    # track state per file (full path) for uploads, per filename for
    # what we've already received from teacher - avoids re-copying the
    # same content to clipboard over and over
    last_uploaded_content = {}
    last_received_content = {}

    # upload everything once right away so teacher sees it immediately
    # instead of waiting for the first change
    for p in watched_paths:
        filename = os.path.basename(p)
        try:
            with open(p, "r", encoding="utf-8") as f:
                content = f.read()
            upload_current_content(signature, p, content)
            last_uploaded_content[p] = content
            print(f"[{time.strftime('%H:%M:%S')}] Initial upload of '{filename}' sent.")
        except Exception as e:
            print(f"Initial upload of '{filename}' failed: {e}")

    while True:
        # check each watched file for local changes
        for p in watched_paths:
            filename = os.path.basename(p)
            try:
                with open(p, "r", encoding="utf-8") as f:
                    content = f.read()
                if content != last_uploaded_content.get(p):
                    upload_current_content(signature, p, content)
                    last_uploaded_content[p] = content
                    print(f"[{time.strftime('%H:%M:%S')}] Synced local change in '{filename}'")
            except Exception as e:
                print(f"[{time.strftime('%H:%M:%S')}] Couldn't read '{filename}': {e}")

        # check backend for anything teacher pushed
        try:
            resp = requests.get(f"{API_BASE}/poll/{signature}", timeout=5)
            resp.raise_for_status()
            for f in resp.json().get("files", []):
                fname = f.get("filename", "unknown")
                fcontent = f.get("content", "")
                if last_received_content.get(fname) != fcontent:
                    last_received_content[fname] = fcontent
                    pyperclip.copy(fcontent)
                    print(f"[{time.strftime('%H:%M:%S')}] 📋 Copied teacher's update for '{fname}' — just press Ctrl+V")
                    toast("MockingBird", f"Update for {fname} copied — Ctrl+V to paste")
        except requests.exceptions.RequestException as e:
            print(f"[{time.strftime('%H:%M:%S')}] Couldn't reach backend: {e}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
