"""
gofile.io wrapper + all our db stuff lives here too (probably should be
split into two files honestly but whatever, works for now).

couple things worth knowing if you're reading this:
- gofile's upload endpoint moved to upload.gofile.io at some point, the
  old api.gofile.io/uploadFile just 404s now. took me a while to figure
  that out
- gofile's "list files in a folder" endpoint is premium-only so we can't
  use it to check what's been uploaded. instead we just keep our own
  copy of everything in postgres and treat gofile as basically just a
  backup / shareable link generator
- classrooms table exists so multiple teachers can use the same backend
  without their rosters getting mixed together
"""

import os
from contextlib import contextmanager
from datetime import datetime, timezone
import random
import string

import httpx
import psycopg2
import psycopg2.extras
from psycopg2.pool import SimpleConnectionPool
from dotenv import load_dotenv

load_dotenv()

GOFILE_UPLOAD_BASE = "https://upload.gofile.io"
GOFILE_TOKEN = os.getenv("GOFILE_TOKEN", "")
GOFILE_FOLDER_ID = os.getenv("GOFILE_FOLDER_ID", "")

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/mockingbird",
)

# connection pool instead of opening a new conn every request, seemed
# wasteful otherwise for something this small
_pool = SimpleConnectionPool(1, 10, DATABASE_URL)


@contextmanager
def _get_conn():
    conn = _pool.getconn()
    try:
        conn.cursor_factory = psycopg2.extras.RealDictCursor
        yield conn
    finally:
        _pool.putconn(conn)


def init_db():
    # just creates tables if they don't exist yet, safe to run every
    # time the server starts
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS classrooms (
                    code TEXT PRIMARY KEY
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    signature TEXT PRIMARY KEY,
                    name TEXT,
                    classroom_code TEXT,
                    role TEXT,
                    last_seen TEXT
                )
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS uploads (
                    signature TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    content TEXT,
                    tagged_name TEXT,
                    download_url TEXT,
                    uploaded_at TEXT,
                    PRIMARY KEY (signature, filename)
                )
            """)
        conn.commit()


def gen_signature(length=24):
    # same scheme the old desktop app used for gen_sig()
    chars = string.ascii_letters + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def gen_classroom_code(length=6):
    # shorter than a signature since a teacher has to read this out loud
    # to a whole class
    chars = string.ascii_uppercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))


def create_classroom():
    with _get_conn() as conn:
        with conn.cursor() as cur:
            # keep rerolling until we get one that's not taken. with 6
            # chars this basically never loops more than once
            while True:
                code = gen_classroom_code()
                cur.execute("SELECT 1 FROM classrooms WHERE code = %s", (code,))
                if cur.fetchone() is None:
                    break
            cur.execute("INSERT INTO classrooms (code) VALUES (%s)", (code,))
        conn.commit()
    return code


def ensure_classroom(code):
    # for when a teacher already has a code saved locally and just wants
    # to reconnect to it - don't generate new, just make sure it exists
    if not code:
        return
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO classrooms (code) VALUES (%s) ON CONFLICT DO NOTHING",
                (code,),
            )
        conn.commit()


def classroom_exists(code):
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM classrooms WHERE code = %s", (code,))
            return cur.fetchone() is not None


def touch(signature, name=None, classroom_code=None, role=None):
    # called basically everywhere (register/upload/poll) just to bump
    # last_seen. name/classroom/role only get SET if passed in, we never
    # want a plain poll call wiping out someone's name because it passed
    # None for it
    now = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT name, classroom_code, role FROM sessions WHERE signature = %s",
                (signature,),
            )
            existing = cur.fetchone()

            final_name = name or (existing["name"] if existing else None)
            final_classroom = classroom_code or (existing["classroom_code"] if existing else None)
            final_role = role or (existing["role"] if existing else None)

            cur.execute(
                """
                INSERT INTO sessions (signature, name, classroom_code, role, last_seen)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (signature) DO UPDATE SET
                    name = EXCLUDED.name,
                    classroom_code = EXCLUDED.classroom_code,
                    role = EXCLUDED.role,
                    last_seen = EXCLUDED.last_seen
                """,
                (signature, final_name, final_classroom, final_role, now),
            )
        conn.commit()


async def upload_file(file_bytes, filename, signature):
    tagged_name = f"{signature}__{filename}"
    download_url = None
    file_id = None
    upload_error = None

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            files = {"file": (tagged_name, file_bytes)}
            data = {}
            if GOFILE_FOLDER_ID:
                data["folderId"] = GOFILE_FOLDER_ID
            if GOFILE_TOKEN:
                data["token"] = GOFILE_TOKEN

            resp = await client.post(
                f"{GOFILE_UPLOAD_BASE}/uploadfile",
                files=files,
                data=data,
            )
            resp.raise_for_status()
            body = resp.json()
            if body.get("status") == "ok":
                payload = body.get("data", {})
                file_id = payload.get("id")
                download_url = payload.get("downloadPage")
            else:
                upload_error = body.get("status", "unknown gofile error")
    except Exception as e:
        # gofile going down shouldn't break the actual classroom flow -
        # we still save to our own db below regardless
        upload_error = str(e)

    try:
        content = file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        content = "<binary file — cannot display as text>"

    now = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO uploads (signature, filename, content, tagged_name, download_url, uploaded_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (signature, filename) DO UPDATE SET
                    content = EXCLUDED.content,
                    tagged_name = EXCLUDED.tagged_name,
                    download_url = EXCLUDED.download_url,
                    uploaded_at = EXCLUDED.uploaded_at
                """,
                (signature, filename, content, tagged_name, download_url, now),
            )
        conn.commit()

    touch(signature)

    # file is already safe in our db at this point, so a gofile failure
    # isn't a real failure - just log it. before this the browser student
    # page treated gofile's 500 as a failed upload and never started
    # watching the file
    if upload_error:
        print(f"gofile upload failed (saved to db anyway): {upload_error}")

    return {
        "success": True,
        "file_id": file_id,
        "download_url": download_url,
        "tagged_name": tagged_name,
        "error": None,
    }


def get_files_for(signature):
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM uploads WHERE signature = %s", (signature,))
            return [dict(row) for row in cur.fetchall()]


def get_roster(classroom_code):
    # this is the important one - filters by classroom so teacher A
    # never sees teacher B's students
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT s.signature, s.name, s.last_seen,
                       (SELECT COUNT(*) FROM uploads u WHERE u.signature = s.signature) AS file_count
                FROM sessions s
                WHERE s.classroom_code = %s AND s.role = 'student'
                """,
                (classroom_code,),
            )
            return [dict(row) for row in cur.fetchall()]


def delete_classroom(classroom_code):
    # wipes everything tied to this classroom. no undo, be careful
    with _get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM uploads
                WHERE signature IN (
                    SELECT signature FROM sessions WHERE classroom_code = %s
                )
                """,
                (classroom_code,),
            )
            cur.execute(
                "DELETE FROM sessions WHERE classroom_code = %s", (classroom_code,)
            )
            cur.execute(
                "DELETE FROM classrooms WHERE code = %s", (classroom_code,)
            )
        conn.commit()


init_db()
