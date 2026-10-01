// wrapper around all our backend calls, just plain functions instead of
// a class since there's no real state to hold onto here

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000/api";

export async function registerClient(role, { name, classroomCode } = {}) {
  const params = new URLSearchParams({ role });
  if (name) params.set("name", name);
  if (classroomCode) params.set("classroom_code", classroomCode);

  const res = await fetch(`${API_BASE}/register?${params.toString()}`, { method: "POST" });
  if (!res.ok) {
    let detail = "Could not register with the server";
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // couldn't parse the error body, just use the default message above
    }
    throw new Error(detail);
  }
  return res.json(); // { signature, role, name, classroom_code }
}

export async function uploadFile(signature, file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${API_BASE}/upload?signature=${signature}`, {
    method: "POST",
    body: form,
  });
  return res.json(); // { success, file_id, download_url, tagged_name, error }
}

export async function pollForFiles(signature) {
  const res = await fetch(`${API_BASE}/poll/${signature}`);
  if (!res.ok) throw new Error("Poll failed");
  return res.json(); // { files: [...] }
}

export async function getRoster(classroomCode) {
  const res = await fetch(`${API_BASE}/roster?classroom_code=${encodeURIComponent(classroomCode)}`);
  if (!res.ok) throw new Error("Could not fetch roster");
  return res.json(); // { students: [...] }
}

export async function endClassroom(classroomCode) {
  const res = await fetch(`${API_BASE}/classroom/${encodeURIComponent(classroomCode)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    let detail = "Could not end the classroom";
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // meh, just use the default
    }
    throw new Error(detail);
  }
  return res.json(); // { success: true }
}

export async function checkHealth() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
