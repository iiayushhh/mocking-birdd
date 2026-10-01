import { useState, useEffect, useRef } from 'react';
import { registerClient, uploadFile, pollForFiles } from '../api/mockingbird';

const supportsFileSystemAccess = typeof window !== 'undefined' && 'showOpenFilePicker' in window;

const NAME_KEY = 'mb_student_name';
const ROLL_KEY = 'mb_student_roll';
const CLASSROOM_KEY = 'mb_student_classroom';
const SIGNATURE_KEY = 'mb_student_signature';

// tiny indexeddb wrapper just to remember the picked file handle across
// page reloads/navigation. localStorage can't hold a FileSystemFileHandle
// (it's not a string), indexeddb can since it supports structured clone
const HANDLE_DB_NAME = 'mockingbird';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'watched_file';

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandleToDB(handle) {
  try {
    const db = await openHandleDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // not the end of the world if this fails, just means the student
    // has to click "Choose & Watch File" again after navigating away
  }
}

async function loadHandleFromDB() {
  try {
    const db = await openHandleDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export default function StudentView() {
  // join form stuff. only asked once, then saved in localStorage so a
  // refresh doesn't make the student fill it in again
  const [joined, setJoined] = useState(false);
  const [formName, setFormName] = useState('');
  const [formRoll, setFormRoll] = useState('');
  const [formCode, setFormCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [joining, setJoining] = useState(false);

  const [signature, setSignature] = useState(null);
  const [status, setStatus] = useState('connecting...');
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [receivedFiles, setReceivedFiles] = useState([]);
  const [notifPermission, setNotifPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [liveWatching, setLiveWatching] = useState(false);
  const [liveFilename, setLiveFilename] = useState(null);
  const [needsResumeClick, setNeedsResumeClick] = useState(false);
  const [resuming, setResuming] = useState(false);

  const lastFileCount = useRef(0);
  const fileHandleRef = useRef(null);
  const lastContentRef = useRef(null);

  // already joined before? skip the form and just reuse the same
  // session instead of registering fresh - a fresh register() call
  // always mints a brand new signature on the backend, which was
  // causing a new "student" entry to show up in the teacher's roster
  // every single time this page was revisited
  useEffect(() => {
    const savedName = localStorage.getItem(NAME_KEY);
    const savedRoll = localStorage.getItem(ROLL_KEY);
    const savedCode = localStorage.getItem(CLASSROOM_KEY);
    const savedSignature = localStorage.getItem(SIGNATURE_KEY);

    if (savedName && savedCode && savedSignature) {
      // we already have a session, just resume it directly - no need
      // to call the backend at all here, poll/upload will touch() it
      setFormName(savedName);
      setFormRoll(savedRoll || '');
      setFormCode(savedCode);
      setSignature(savedSignature);
      setStatus('connected');
      setJoined(true);
    } else if (savedName && savedCode) {
      // older session from before we started saving the signature -
      // register once more, this time it'll get saved for next time
      setFormName(savedName);
      setFormRoll(savedRoll || '');
      setFormCode(savedCode);
      doJoin(savedName, savedRoll, savedCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // once we're actually connected, check if there's a file we were
  // watching before (from indexeddb) and try to pick back up without
  // making the student choose the file again. browsers only let us
  // silently reuse a handle if permission is still 'granted' from last
  // time - if it's expired to 'prompt' we show a one-click resume button
  // instead of the full file picker (requestPermission needs a click,
  // browsers won't allow it to happen silently on page load)
  useEffect(() => {
    if (!signature || !supportsFileSystemAccess) return;

    (async () => {
      const handle = await loadHandleFromDB();
      if (!handle) return;

      fileHandleRef.current = handle;
      const perm = await handle.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        await resumeWatching(handle);
      } else {
        setNeedsResumeClick(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const resumeWatching = async (handle) => {
    try {
      const file = await handle.getFile();
      const text = await file.text();
      lastContentRef.current = text;
      setLiveFilename(file.name);
      setUploadedFile(file.name);
      setLiveWatching(true);
      setNeedsResumeClick(false);
      // re-upload in case it changed while this tab was closed
      await doUpload(new File([text], file.name, { type: 'text/plain' }));
    } catch (err) {
      console.error('Resume failed:', err);
      setNeedsResumeClick(true);
    }
  };

  const handleResumeClick = async () => {
    const handle = fileHandleRef.current;
    if (!handle) return;
    setResuming(true);
    try {
      const perm = await handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        await resumeWatching(handle);
      } else {
        setUploadError('Permission was denied — pick the file again with "Choose & Watch File".');
      }
    } catch (err) {
      console.error('Permission request failed:', err);
    } finally {
      setResuming(false);
    }
  };

  const doJoin = async (name, roll, code) => {
    setJoining(true);
    setJoinError('');

    const displayName = roll ? `${name} (${roll})` : name;

    try {
      const res = await registerClient('student', {
        name: displayName,
        classroomCode: code.trim().toUpperCase(),
      });
      setSignature(res.signature);
      setStatus('connected');
      setJoined(true);

      localStorage.setItem(NAME_KEY, name);
      localStorage.setItem(ROLL_KEY, roll);
      localStorage.setItem(CLASSROOM_KEY, code.trim().toUpperCase());
      localStorage.setItem(SIGNATURE_KEY, res.signature);
    } catch (err) {
      console.error('Join failed:', err);
      setJoinError(err.message || "Couldn't join — check the classroom code and try again.");
      setStatus("couldn't connect");
    } finally {
      setJoining(false);
    }
  };

  const handleJoinSubmit = (e) => {
    e.preventDefault();
    if (!formName.trim() || !formCode.trim()) {
      setJoinError('Name and classroom code are required.');
      return;
    }
    doJoin(formName.trim(), formRoll.trim(), formCode.trim());
  };

  const enableNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    const perm = await Notification.requestPermission();
    setNotifPermission(perm);
    if (perm === 'granted') {
      try {
        await navigator.clipboard.writeText('');
      } catch {
        /* ignore */
      }
    }
  };

  const doUpload = async (file) => {
    const result = await uploadFile(signature, file);
    if (result.success === false || result.error) {
      throw new Error(result.error || 'Upload failed');
    }
    return result;
  };

  // old-school upload, only used if the browser can't do live watching
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !signature) return;

    setUploading(true);
    setUploadStatus(`Uploading ${file.name}...`);
    setUploadError('');

    try {
      await doUpload(file);
      setUploadedFile(file.name);
      setUploadStatus(`✅ Uploaded: ${file.name}`);
      setTimeout(() => setUploadStatus(''), 2000);
    } catch (err) {
      console.error('Upload failed:', err);
      setUploadError(`Upload failed: ${err.message}`);
      setUploadStatus('');
    } finally {
      setUploading(false);
    }
  };

  // pick a file with the File System Access API and hold onto the handle
  // so we can keep re-reading it for changes (chrome/edge/brave only)
  const handlePickLiveFile = async () => {
    if (!signature) return;
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Code files', accept: { 'text/*': ['.txt', '.py', '.js', '.jsx', '.ts', '.java', '.c', '.cpp', '.html', '.css', '.md'] } }],
        multiple: false,
      });
      fileHandleRef.current = handle;
      const file = await handle.getFile();
      const text = await file.text();
      lastContentRef.current = text;

      await saveHandleToDB(handle); // so we can resume this on next visit without re-picking

      setUploading(true);
      setUploadStatus(`Uploading ${file.name}...`);
      await doUpload(new File([text], file.name, { type: 'text/plain' }));
      setUploadedFile(file.name);
      setLiveFilename(file.name);
      setLiveWatching(true);
      setUploadStatus(`✅ Watching ${file.name} for changes`);
      setTimeout(() => setUploadStatus(''), 2000);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('File pick failed:', err);
        setUploadError(`Couldn't open file: ${err.message}`);
      }
    } finally {
      setUploading(false);
    }
  };

  // re-read the file every second, upload if it changed
  useEffect(() => {
    if (!liveWatching || !signature) return;

    const id = setInterval(async () => {
      const handle = fileHandleRef.current;
      if (!handle) return;
      try {
        const file = await handle.getFile();
        const text = await file.text();
        if (text !== lastContentRef.current) {
          lastContentRef.current = text;
          await doUpload(new File([text], file.name, { type: 'text/plain' }));
          setUploadStatus(`🔄 Synced ${file.name}`);
          setTimeout(() => setUploadStatus(''), 1200);
        }
      } catch (err) {
        console.error('Live sync failed:', err);
        setLiveWatching(false);
        setUploadError('Lost access to the file — pick it again to resume live sync.');
      }
    }, 1000);

    return () => clearInterval(id);
  }, [liveWatching, signature]);

  const copyToClipboard = async (content) => {
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch (err) {
      console.error('Clipboard write failed:', err);
      return false;
    }
  };

  const announceNewFile = (file) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification('📝 Teacher pushed an update', {
        body: `${file.filename} — click to copy to clipboard`,
        requireInteraction: true,
      });
      n.onclick = async () => {
        window.focus();
        const ok = await copyToClipboard(file.content);
        n.close();
        alert(ok
          ? `✅ Copied ${file.filename} — press Ctrl+V to paste.`
          : `Couldn't auto-copy. Use the Copy button on the page for ${file.filename}.`);
      };
      return;
    }

    copyToClipboard(file.content).then((ok) => {
      alert(ok
        ? `📝 Teacher sent updated file: ${file.filename}\n\nContent copied to clipboard.\n\nPress Ctrl+V to paste in your editor.`
        : `📝 Teacher sent: ${file.filename}\n\nCouldn't auto-copy. Click "Copy" next to the file below.`);
    });
  };

  useEffect(() => {
    if (!signature) return;

    const id = setInterval(async () => {
      try {
        const data = await pollForFiles(signature);
        if (data.files && data.files.length > 0) {
          const newFileCount = data.files.length;
          if (newFileCount > lastFileCount.current) {
            const newFiles = data.files.slice(lastFileCount.current);
            newFiles.forEach((file) => announceNewFile(file));
          }
          lastFileCount.current = newFileCount;
          setReceivedFiles(data.files);
        }
      } catch (err) {
        console.error('Failed to poll files:', err);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [signature]);

  // show the join form until the student has actually joined
  if (!joined) {
    return (
      <div style={styles.container}>
        <h1>Student View</h1>

        <form onSubmit={handleJoinSubmit} style={styles.joinCard}>
          <h2 style={{ marginTop: 0 }}>👋 Join your classroom</h2>
          <p style={{ color: '#666', fontSize: '14px', marginBottom: '20px' }}>
            Ask your teacher for the classroom code, then fill this in once —
            you won't need to do it again on this device.
          </p>

          <label style={styles.label}>
            Name
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Your full name"
              style={styles.input}
              disabled={joining}
              required
            />
          </label>

          <label style={styles.label}>
            Roll number <span style={{ color: '#999', fontWeight: 400 }}>(optional)</span>
            <input
              type="text"
              value={formRoll}
              onChange={(e) => setFormRoll(e.target.value)}
              placeholder="e.g. CS-42"
              style={styles.input}
              disabled={joining}
            />
          </label>

          <label style={styles.label}>
            Classroom code
            <input
              type="text"
              value={formCode}
              onChange={(e) => setFormCode(e.target.value.toUpperCase())}
              placeholder="e.g. A3F9K2"
              style={{ ...styles.input, fontFamily: 'monospace', letterSpacing: '0.1em' }}
              disabled={joining}
              required
            />
          </label>

          {joinError && (
            <p style={{ color: '#e74c3c', fontSize: '13px', marginBottom: '12px' }}>{joinError}</p>
          )}

          <button type="submit" disabled={joining} style={styles.joinButton}>
            {joining ? 'Joining...' : 'Join Classroom'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1>Student View</h1>

      <div style={styles.statusSection}>
        {status === 'connected' ? (
          <>
            <span style={styles.connectedBadge}>connected</span>
            <p style={styles.sessionId}>
              Your session ID: <code>{signature}</code>
            </p>
          </>
        ) : (
          <p style={{ color: '#e74c3c' }}>{status}</p>
        )}
      </div>

      {notifPermission !== 'granted' && (
        <div style={styles.notifBanner}>
          <p style={{ margin: '0 0 10px 0' }}>
            🔔 Turn on notifications so you get a popup the instant your teacher pushes an update —
            even while you're working in VS Code or Notepad.
          </p>
          <button onClick={enableNotifications} style={styles.enableButton}>
            Enable Notifications
          </button>
        </div>
      )}

      <div style={styles.uploadSection}>
        <h2>📤 Your Code File</h2>

        {supportsFileSystemAccess ? (
          <>
            <p style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>
              Pick the file you're working on — MockingBird will keep it synced live as you type,
              so your teacher always sees your latest code.
            </p>
            <button onClick={handlePickLiveFile} disabled={uploading} style={styles.uploadButton}>
              {uploading ? '⏳ Working...' : liveWatching ? '📁 Switch File' : '📁 Choose & Watch File'}
            </button>
            {needsResumeClick && !liveWatching && (
              <div style={{ marginTop: '12px' }}>
                <p style={{ fontSize: '13px', color: '#666', marginBottom: '8px' }}>
                  You had a file open before — click below to pick up where you left off
                  (the browser needs a click to re-confirm access after navigating away).
                </p>
                <button onClick={handleResumeClick} disabled={resuming} style={styles.uploadButton}>
                  {resuming ? '⏳ Resuming...' : '▶️ Resume watching my file'}
                </button>
              </div>
            )}
            {liveWatching && (
              <p style={{ ...styles.statusMessage, color: '#27ae60', marginTop: '12px' }}>
                🟢 Live-syncing <code>{liveFilename}</code> — just keep editing and saving in your editor.
              </p>
            )}
          </>
        ) : (
          <>
            <p style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>
              Upload the code file you're working on. (Your browser doesn't support live sync —
              re-upload manually whenever you make changes.)
            </p>
            <div style={styles.fileInputWrapper}>
              <input
                id="student-file-upload"
                type="file"
                onChange={handleFileUpload}
                disabled={uploading || !signature}
                style={styles.fileInputHidden}
              />
              <label htmlFor="student-file-upload" style={styles.uploadButton}>
                {uploading ? '⏳ Uploading...' : '📁 Choose File'}
              </label>
            </div>
          </>
        )}

        {uploadStatus && (
          <p style={{ ...styles.statusMessage, color: '#2ecc71', marginTop: '12px' }}>
            {uploadStatus}
          </p>
        )}
        {uploadError && (
          <p style={{ ...styles.statusMessage, color: '#e74c3c', marginTop: '12px' }}>
            {uploadError}
          </p>
        )}
        {uploadedFile && !liveWatching && (
          <p style={{ ...styles.statusMessage, color: '#3d5a80', marginTop: '12px', fontWeight: '600' }}>
            ✓ Currently uploaded: <code>{uploadedFile}</code>
          </p>
        )}
      </div>

      <div style={styles.receivedSection}>
        <h2>📥 Received Updates from Teacher</h2>
        {receivedFiles.length === 0 ? (
          <p style={{ color: '#999' }}>
            Waiting for teacher's edits — you'll get notified when they push changes.
          </p>
        ) : (
          <div style={styles.filesList}>
            {receivedFiles.map((file, idx) => (
              <div key={idx} style={styles.fileItem}>
                <div style={styles.fileIcon}>📄</div>
                <div style={styles.fileInfo}>
                  <p style={styles.fileName}>{file.filename}</p>
                  <p style={styles.filePreview}>
                    {file.content.substring(0, 100)}
                    {file.content.length > 100 ? '...' : ''}
                  </p>
                </div>
                <button
                  onClick={async () => {
                    const ok = await copyToClipboard(file.content);
                    alert(ok ? 'Copied to clipboard!' : 'Copy failed — try again.');
                  }}
                  style={styles.copyButton}
                >
                  Copy
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p style={styles.hint}>
        💡 With notifications enabled, click the popup to copy — even while you're in another app.
        Then press <strong>Ctrl+V</strong> to paste.
      </p>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: '900px',
    margin: '0 auto',
    padding: '40px 20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#faf9f6',
    minHeight: '100vh',
  },
  joinCard: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '28px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    maxWidth: '420px',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#333',
    marginBottom: '16px',
  },
  input: {
    padding: '10px 12px',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '400',
  },
  joinButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    border: 'none',
    padding: '12px 24px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
  },
  statusSection: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  connectedBadge: {
    display: 'inline-block',
    backgroundColor: '#d5f4e6',
    color: '#27ae60',
    padding: '4px 12px',
    borderRadius: '20px',
    fontSize: '12px',
    fontWeight: '600',
    marginBottom: '12px',
  },
  sessionId: {
    margin: '8px 0 0 0',
    fontSize: '14px',
    color: '#666',
  },
  notifBanner: {
    backgroundColor: '#fff8e1',
    border: '1px solid #ffe082',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '20px',
  },
  enableButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    border: 'none',
    padding: '10px 20px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  uploadSection: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  fileInputWrapper: {
    marginTop: '12px',
  },
  fileInputHidden: {
    display: 'none',
  },
  uploadButton: {
    display: 'inline-block',
    backgroundColor: '#3d5a80',
    color: 'white',
    padding: '12px 24px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    userSelect: 'none',
    border: 'none',
  },
  statusMessage: {
    fontSize: '13px',
    fontWeight: '500',
  },
  receivedSection: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '20px',
    marginBottom: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  filesList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  fileItem: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '12px',
    backgroundColor: '#fafaf8',
    borderRadius: '6px',
    border: '1px solid #f0f0f0',
  },
  fileIcon: {
    fontSize: '24px',
    flexShrink: 0,
  },
  fileInfo: {
    flex: 1,
    minWidth: 0,
  },
  fileName: {
    margin: '0 0 4px 0',
    fontWeight: '600',
    color: '#333',
    fontSize: '14px',
  },
  filePreview: {
    margin: 0,
    fontSize: '12px',
    color: '#999',
    wordBreak: 'break-word',
    lineHeight: '1.4',
  },
  copyButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    border: 'none',
    padding: '6px 12px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background-color 0.2s',
  },
  hint: {
    padding: '12px',
    backgroundColor: '#ecf0f1',
    borderLeft: '3px solid #3d5a80',
    fontSize: '13px',
    color: '#333',
    lineHeight: '1.5',
  },
};
