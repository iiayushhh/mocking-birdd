"""
FastAPI backend for MockingBird. Talks to Postgres for storage and
gofile.io as a dumb file relay (we don't really need gofile for much
anymore since we cache everything in the db, but keeping it since it
still gives students a shareable link).

run: uvicorn main:app --reload --port 8000
docs: localhost:8000/docs
"""

import os

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

from models import (
    RegisterResponse,
    UploadResponse,
    PollResponse,
    PolledFile,
    RosterResponse,
    RosterEntry,
)
import gofile_client as gofile

app = FastAPI(
    title="MockingBird Bridge API",
    description="Relays classroom files between students and teacher via gofile.io",
    version="0.6.0",
)

# only allow requests from our own frontend. reads from .env so we can
# change it without touching code when we deploy. don't set this to "*"
# once this is live on the internet, learned that the hard way lol
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173")
ALLOWED_ORIGINS = [origin.strip() for origin in _allowed_origins_env.split(",") if origin.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}


@app.post("/api/register", response_model=RegisterResponse)
async def register(role: str, name: str | None = None, classroom_code: str | None = None):
    # teacher gets a fresh classroom code (or reuses their saved one).
    # student HAS to give a valid classroom code or we reject them -
    # otherwise every teacher's roster would just be one giant mixed list
    if role not in ("student", "teacher"):
        raise HTTPException(400, "role must be 'student' or 'teacher'")

    signature = gofile.gen_signature()

    if role == "teacher":
        if classroom_code:
            gofile.ensure_classroom(classroom_code)
            code = classroom_code
        else:
            code = gofile.create_classroom()
    else:
        if not classroom_code:
            raise HTTPException(400, "classroom_code is required to join as a student")
        if not gofile.classroom_exists(classroom_code):
            raise HTTPException(404, "That classroom code wasn't found — check it with your teacher")
        code = classroom_code

    gofile.touch(signature, name=name, classroom_code=code, role=role)
    return RegisterResponse(signature=signature, role=role, name=name, classroom_code=code)


@app.post("/api/upload", response_model=UploadResponse)
async def upload(signature: str, file: UploadFile = File(...)):
    gofile.touch(signature)
    contents = await file.read()
    try:
        result = await gofile.upload_file(contents, file.filename, signature)
        return UploadResponse(**result)
    except Exception as e:
        # swallow errors here instead of 500ing - frontend shows the
        # error message instead of just hanging
        return UploadResponse(success=False, error=str(e))


@app.get("/api/poll/{signature}", response_model=PollResponse)
async def poll(signature: str):
    # both students and teacher hit this - student polls to check if
    # teacher pushed something, teacher polls when viewing a student's file
    gofile.touch(signature)
    mine = gofile.get_files_for(signature)
    return PollResponse(files=[PolledFile(**f) for f in mine])


@app.get("/api/roster", response_model=RosterResponse)
async def roster(classroom_code: str):
    entries = gofile.get_roster(classroom_code)
    students = [RosterEntry(**e) for e in entries]
    return RosterResponse(students=students)


@app.delete("/api/classroom/{classroom_code}")
async def end_classroom(classroom_code: str):
    # nukes everything for this classroom - all students, all their
    # files, gone. frontend confirms with the teacher before calling this
    if not gofile.classroom_exists(classroom_code):
        raise HTTPException(404, "That classroom code wasn't found")
    gofile.delete_classroom(classroom_code)
    return {"success": True}
