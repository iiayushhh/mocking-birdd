import { useState, useEffect, useRef } from 'react';
import { registerClient, getRoster, uploadFile, pollForFiles, endClassroom } from '../api/mockingbird';

const CLASSROOM_STORAGE_KEY = 'mb_teacher_classroom_code';

export default function TeacherDashboard() {
  // stage goes checking -> choosing (only if no saved code) -> registered
  const [stage, setStage] = useState('checking');
  const [classroomCode, setClassroomCode] = useState(null);
  const [registerError, setRegisterError] = useState('');
  const [rejoinInput, setRejoinInput] = useState('');
  const [rejoinError, setRejoinError] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [ending, setEnding] = useState(false);

  const [roster, setRoster] = useState([]);
  const [selectedStudent, setSelectedStudent] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [studentFiles, setStudentFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [pushing, setPushing] = useState(false);
  const [pushStatus, setPushStatus] = useState('');
  const [error, setError] = useState('');
  const [liveContent, setLiveContent] = useState(null); // latest content from student, unmerged into editor
  const [hasNewerLive, setHasNewerLive] = useState(false);

  const selectedStudentRef = useRef(null);
  const selectedFileRef = useRef(null);
  selectedStudentRef.current = selectedStudent;
  selectedFileRef.current = selectedFile;

  const registerWithCode = async (codeToUse) => {
    try {
      const res = await registerClient('teacher', { classroomCode: codeToUse });
      setClassroomCode(res.classroom_code);
      localStorage.setItem(CLASSROOM_STORAGE_KEY, res.classroom_code);
      setRegisterError('');
      setStage('registered');
    } catch (err) {
      console.error('Teacher registration failed:', err);
      setRegisterError("Couldn't connect to the backend — check it's running.");
      setStage('registered'); // still move on so the error actually shows up
    }
  };

  // check localStorage first - if teacher already has a code saved just
  // use that. if not (new browser/device, cache cleared etc) don't
  // silently make a new classroom, ask them what they want first
  useEffect(() => {
    const savedCode = localStorage.getItem(CLASSROOM_STORAGE_KEY);
    if (savedCode) {
      registerWithCode(savedCode);
    } else {
      setStage('choosing');
    }
  }, []);

  const startNewClassroom = () => {
    setStage('checking');
    registerWithCode(undefined); // backend makes a new code if we don't pass one
  };

  const handleRejoinSubmit = async (e) => {
    e.preventDefault();
    const code = rejoinInput.trim().toUpperCase();
    if (!code) {
      setRejoinError('Enter the classroom code you used before.');
      return;
    }
    setRejoinError('');
    setStage('checking');
    await registerWithCode(code);
  };

  // basically just forgets the saved code and shows the chooser screen
  // again, so teacher can switch classrooms without messing with browser settings
  const switchClassroom = () => {
    localStorage.removeItem(CLASSROOM_STORAGE_KEY);
    setClassroomCode(null);
    setRoster([]);
    setSelectedStudent(null);
    setSelectedFile(null);
    setStage('choosing');
  };

  // this is permanent, no undo, so we confirm first
  const handleEndClassroom = async () => {
    if (!classroomCode) return;
    const confirmed = window.confirm(
      `End this classroom (${classroomCode})? This permanently deletes all ${roster.length} student(s) and their uploaded files. This cannot be undone.`
    );
    if (!confirmed) return;

    setEnding(true);
    try {
      await endClassroom(classroomCode);
      switchClassroom();
    } catch (err) {
      console.error('Failed to end classroom:', err);
      setError(`Couldn't end classroom: ${err.message}`);
    } finally {
      setEnding(false);
    }
  };

  useEffect(() => {
    if (!classroomCode) return;

    const fetchRoster = async () => {
      try {
        const data = await getRoster(classroomCode);
        setRoster(data.students || data.roster || []);
        setError('');
      } catch (err) {
        console.error('Failed to fetch roster:', err);
        setError('Could not load roster');
      }
    };

    fetchRoster();
    const interval = setInterval(fetchRoster, 4000);
    return () => clearInterval(interval);
  }, [classroomCode]);

  const handleStudentClick = async (student) => {
    setSelectedStudent(student);
    setSelectedFile(null);
    setEditedContent('');
    setLiveContent(null);
    setHasNewerLive(false);
    setLoadingFiles(true);

    try {
      const data = await pollForFiles(student.signature);
      const files = data.files || [];
      setStudentFiles(files);
      if (files.length > 0) {
        setSelectedFile(files[0]);
        setEditedContent(files[0].content || '');
        setLiveContent(files[0].content || '');
      }
    } catch (err) {
      console.error('Failed to fetch student files:', err);
      setStudentFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  };

  // polls every second while a file is open to check if student pushed
  // something new. important: we don't overwrite the textarea automatically
  // or it'd wipe out whatever the teacher is currently typing. just show
  // a banner instead and let them pull it in manually
  useEffect(() => {
    if (!selectedStudent || !selectedFile) return;

    const id = setInterval(async () => {
      const student = selectedStudentRef.current;
      const file = selectedFileRef.current;
      if (!student || !file) return;

      try {
        const data = await pollForFiles(student.signature);
        const files = data.files || [];
        const match = files.find((f) => f.filename === file.filename);
        if (match && match.content !== liveContent) {
          setLiveContent(match.content);
          setHasNewerLive(match.content !== editedContent);
        }
      } catch (err) {
        console.error('Live poll failed:', err);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [selectedStudent, selectedFile, liveContent, editedContent]);

  const pullLatest = () => {
    if (liveContent == null) return;
    setEditedContent(liveContent);
    setHasNewerLive(false);
  };

  const handlePushChanges = async () => {
    if (!selectedFile || !selectedStudent) return;

    setPushing(true);
    setPushStatus('Pushing changes...');

    try {
      const blob = new Blob([editedContent], { type: 'text/plain' });
      const editedFile = new File([blob], selectedFile.filename, { type: 'text/plain' });

      const result = await uploadFile(selectedStudent.signature, editedFile);
      if (result.success === false || result.error) {
        throw new Error(result.error || 'Push failed');
      }

      const label = selectedStudent.name || `${selectedStudent.signature.substring(0, 8)}...`;
      setPushStatus(`✅ Pushed to ${label}`);
      setTimeout(() => setPushStatus(''), 2000);
    } catch (err) {
      console.error('Push failed:', err);
      setPushStatus('');
      setError(`Push failed: ${err.message}`);
    } finally {
      setPushing(false);
    }
  };

  if (stage === 'checking') {
    return (
      <div style={styles.container}>
        <h1>Teacher Dashboard</h1>
        <p style={{ color: '#999' }}>Connecting...</p>
      </div>
    );
  }

  if (stage === 'choosing') {
    return (
      <div style={styles.container}>
        <h1>Teacher Dashboard</h1>
        <div style={styles.chooserCard}>
          <h2 style={{ marginTop: 0 }}>Welcome back 👋</h2>
          <p style={{ color: '#666', fontSize: '14px', marginBottom: '20px' }}>
            We don't see a classroom saved on this browser. Are you starting a
            brand-new classroom, or picking back up one you already had —
            maybe on a different device, or after clearing your browser data?
          </p>

          <button onClick={startNewClassroom} style={styles.primaryButton}>
            🆕 Start a new classroom
          </button>

          <div style={styles.divider}>or</div>

          <form onSubmit={handleRejoinSubmit}>
            <label style={styles.label}>
              Rejoin with an existing classroom code
              <input
                type="text"
                value={rejoinInput}
                onChange={(e) => setRejoinInput(e.target.value.toUpperCase())}
                placeholder="e.g. A3F9K2"
                style={{ ...styles.input, fontFamily: 'monospace', letterSpacing: '0.1em' }}
              />
            </label>
            {rejoinError && (
              <p style={{ color: '#e74c3c', fontSize: '13px', marginBottom: '12px' }}>{rejoinError}</p>
            )}
            <button type="submit" style={styles.secondaryButton}>
              Rejoin classroom
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (registerError) {
    return (
      <div style={styles.container}>
        <h1>Teacher Dashboard</h1>
        <div style={styles.errorBanner}>
          <p>{registerError}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1>Teacher Dashboard</h1>

      <div style={styles.classroomBanner}>
        <div>
          <p style={styles.classroomLabel}>Your Classroom Code</p>
          <p style={styles.classroomCode}>{classroomCode}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={styles.classroomHint}>
            Share this code with your students — they'll enter it when they join.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button onClick={switchClassroom} style={styles.switchLink}>
              Not your classroom? Switch code
            </button>
            <button onClick={handleEndClassroom} disabled={ending} style={styles.endLink}>
              {ending ? 'Ending...' : '🗑️ End classroom'}
            </button>
          </div>
        </div>
      </div>

      <button onClick={() => setShowGuide((v) => !v)} style={styles.guideToggle}>
        {showGuide ? '▲ Hide student setup guide' : '▼ Show student setup guide'}
      </button>

      {showGuide && <StudentSetupGuide classroomCode={classroomCode} />}

      <div style={styles.mainLayout}>
        <div style={styles.sidebar}>
          <h2>Students & Uploads</h2>
          {roster.length === 0 ? (
            <p style={{ color: '#999' }}>Waiting for students...</p>
          ) : (
            <div style={styles.studentsList}>
              {roster.map((student) => (
                <div
                  key={student.signature}
                  style={{
                    ...styles.studentCard,
                    backgroundColor:
                      selectedStudent?.signature === student.signature ? '#e8f1f8' : 'white',
                    borderLeft:
                      selectedStudent?.signature === student.signature
                        ? '4px solid #3d5a80'
                        : '4px solid #e0e0e0',
                  }}
                  onClick={() => handleStudentClick(student)}
                >
                  <div style={styles.studentHeader}>
                    <p style={styles.studentSig}>
                      {student.name || student.signature}
                    </p>
                    <span style={styles.fileCountBadge}>{student.file_count ?? 0}</span>
                  </div>
                  {student.name && (
                    <p style={styles.studentSubSig}>{student.signature}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={styles.editorPanel}>
          {loadingFiles ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyText}>⏳ Loading student's files...</p>
            </div>
          ) : selectedStudent && selectedFile ? (
            <>
              <div style={styles.editorHeader}>
                <div>
                  <h2 style={styles.editorTitle}>{selectedFile.filename}</h2>
                  <p style={styles.editorSubtitle}>
                    From: {selectedStudent.name || `${selectedStudent.signature.substring(0, 12)}...`}
                  </p>
                </div>
                {pushStatus && (
                  <p style={{ ...styles.statusMessage, color: '#2ecc71' }}>{pushStatus}</p>
                )}
              </div>

              {studentFiles.length > 1 && (
                <div style={styles.fileTabs}>
                  {studentFiles.map((f, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setSelectedFile(f);
                        setEditedContent(f.content || '');
                        setLiveContent(f.content || '');
                        setHasNewerLive(false);
                      }}
                      style={{
                        ...styles.fileTab,
                        backgroundColor: f.filename === selectedFile.filename ? '#3d5a80' : '#f0f0f0',
                        color: f.filename === selectedFile.filename ? 'white' : '#333',
                      }}
                    >
                      {f.filename}
                    </button>
                  ))}
                </div>
              )}

              {hasNewerLive && (
                <div style={styles.liveBanner}>
                  <span>🟢 Student has newer changes</span>
                  <button onClick={pullLatest} style={styles.pullButton}>
                    Pull latest into editor
                  </button>
                </div>
              )}

              <textarea
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                style={styles.editor}
                placeholder="Edit the student's code here..."
              />

              <button
                onClick={handlePushChanges}
                disabled={pushing}
                style={{
                  ...styles.pushButton,
                  opacity: pushing ? 0.6 : 1,
                  cursor: pushing ? 'not-allowed' : 'pointer',
                }}
              >
                {pushing ? '⏳ Pushing...' : '📤 Push Changes Back'}
              </button>
            </>
          ) : selectedStudent ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyIcon}>📭</p>
              <p style={styles.emptyText}>This student hasn't uploaded a file yet</p>
            </div>
          ) : (
            <div style={styles.emptyState}>
              <p style={styles.emptyIcon}>👈</p>
              <p style={styles.emptyText}>Select a student's file to edit</p>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <p>{error}</p>
        </div>
      )}
    </div>
  );
}

// separate component just so the guide's own state (copied/not) doesn't
// clutter up the main dashboard component
function StudentSetupGuide({ classroomCode }) {
  const [copied, setCopied] = useState(false);

  const command = `python mockingbird_student.py "path\\to\\your\\file.py"`;

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={styles.guideCard}>
      <h2 style={{ marginTop: 0, fontSize: '17px' }}>🎓 Student Setup Guide</h2>
      <p style={{ color: '#666', fontSize: '13px', marginBottom: '16px' }}>
        Share these steps with your students so they can connect from their own
        laptops — this gets them the automatic clipboard sync, not just the
        browser view.
      </p>

      <ol style={styles.guideList}>
        <li>
          <strong>Install Python</strong> if it isn't already (
          <a href="https://python.org" target="_blank" rel="noreferrer">python.org</a>
          ), then open a terminal and run:
          <pre style={styles.codeBlock}>pip install requests pyperclip plyer</pre>
        </li>
        <li>
          <strong>Get the script</strong> —{' '}
          <a href="/mockingbird_student.py" download style={styles.downloadLink}>
            ⬇ Download mockingbird_student.py
          </a>{' '}
          and save it anywhere on your computer.
        </li>
        <li>
          <strong>Run it</strong>, pointing at the file you're working on:
          <div style={styles.commandRow}>
            <pre style={styles.codeBlock}>{command}</pre>
            <button onClick={copyCommand} style={styles.copySmallButton}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p style={{ fontSize: '12px', color: '#999', margin: '4px 0 0 0' }}>
            Tip: drag the file from File Explorer straight into the terminal
            window instead of typing the path — it fills it in for you.
          </p>
        </li>
        <li>
          <strong>The first time only</strong>, it'll ask for:
          <ul style={{ margin: '6px 0 0 0' }}>
            <li>Your name or roll number</li>
            <li>
              Your teacher's classroom code —{' '}
              <strong style={{ fontFamily: 'monospace' }}>{classroomCode}</strong>
            </li>
          </ul>
          After that it remembers you automatically, every time you run it again.
        </li>
        <li>
          <strong>Keep the terminal running</strong> in the background while you
          work. When your teacher pushes an edit, it's copied to your clipboard
          automatically — just press <strong>Ctrl+V</strong> in your editor.
        </li>
      </ol>

      <p style={styles.guideFootnote}>
        Don't want to use a terminal? Students can also go to the Student page in
        a browser and join with just their name, roll number, and this classroom
        code — they'll just need to click "Copy" manually when an update arrives,
        instead of it happening automatically.
      </p>
    </div>
  );
}

const styles = {
  container: {
    maxWidth: '1400px',
    margin: '0 auto',
    padding: '40px 20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#faf9f6',
    minHeight: '100vh',
  },
  chooserCard: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '28px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    maxWidth: '440px',
  },
  primaryButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    border: 'none',
    padding: '12px 20px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
  },
  secondaryButton: {
    backgroundColor: 'white',
    color: '#3d5a80',
    border: '1px solid #3d5a80',
    padding: '10px 20px',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
  },
  divider: {
    textAlign: 'center',
    color: '#999',
    fontSize: '12px',
    margin: '18px 0',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    fontSize: '13px',
    fontWeight: '600',
    color: '#333',
    marginBottom: '12px',
  },
  input: {
    padding: '10px 12px',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '400',
  },
  classroomBanner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    backgroundColor: '#3d5a80',
    color: 'white',
    borderRadius: '8px',
    padding: '16px 24px',
    marginBottom: '12px',
    flexWrap: 'wrap',
    gap: '10px',
  },
  classroomLabel: {
    margin: '0 0 4px 0',
    fontSize: '12px',
    opacity: 0.8,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  classroomCode: {
    margin: 0,
    fontSize: '28px',
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: '0.1em',
  },
  classroomHint: {
    margin: '0 0 8px 0',
    fontSize: '13px',
    opacity: 0.9,
    maxWidth: '320px',
  },
  switchLink: {
    background: 'none',
    border: 'none',
    color: 'white',
    textDecoration: 'underline',
    fontSize: '12px',
    cursor: 'pointer',
    opacity: 0.85,
    padding: 0,
  },
  endLink: {
    background: 'none',
    border: 'none',
    color: '#ffb4b4',
    textDecoration: 'underline',
    fontSize: '12px',
    cursor: 'pointer',
    opacity: 0.9,
    padding: 0,
  },
  guideToggle: {
    background: 'none',
    border: '1px solid #3d5a80',
    color: '#3d5a80',
    borderRadius: '6px',
    padding: '8px 14px',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '12px',
  },
  guideCard: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '24px',
    marginBottom: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  guideList: {
    margin: 0,
    paddingLeft: '20px',
    fontSize: '14px',
    color: '#333',
    lineHeight: '1.8',
  },
  codeBlock: {
    backgroundColor: '#f5f5f0',
    border: '1px solid #e0e0e0',
    borderRadius: '4px',
    padding: '8px 12px',
    fontSize: '13px',
    fontFamily: 'monospace',
    margin: '6px 0',
    overflowX: 'auto',
    flex: 1,
  },
  commandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  copySmallButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    border: 'none',
    padding: '8px 14px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
  },
  downloadLink: {
    color: '#3d5a80',
    fontWeight: '600',
    textDecoration: 'none',
    borderBottom: '1px solid #3d5a80',
  },
  guideFootnote: {
    marginTop: '16px',
    paddingTop: '16px',
    borderTop: '1px solid #eee',
    fontSize: '12px',
    color: '#999',
    lineHeight: '1.5',
  },
  mainLayout: {
    display: 'grid',
    gridTemplateColumns: '300px 1fr',
    gap: '20px',
    marginTop: '20px',
  },
  sidebar: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    maxHeight: '600px',
    overflowY: 'auto',
  },
  studentsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  studentCard: {
    padding: '12px',
    borderRadius: '6px',
    cursor: 'pointer',
    transition: 'all 0.2s',
    border: '1px solid #e0e0e0',
  },
  studentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  studentSig: {
    margin: 0,
    fontFamily: 'monospace',
    fontSize: '12px',
    color: '#3d5a80',
    fontWeight: '600',
  },
  studentSubSig: {
    margin: '4px 0 0 0',
    fontFamily: 'monospace',
    fontSize: '10px',
    color: '#aaa',
  },
  fileCountBadge: {
    backgroundColor: '#3d5a80',
    color: 'white',
    padding: '2px 8px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: '600',
  },
  editorPanel: {
    backgroundColor: 'white',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '20px',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
  },
  editorHeader: {
    marginBottom: '16px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  editorTitle: {
    margin: '0 0 4px 0',
    fontSize: '18px',
    color: '#333',
  },
  editorSubtitle: {
    margin: 0,
    fontSize: '12px',
    color: '#999',
  },
  statusMessage: {
    fontSize: '13px',
    fontWeight: '600',
  },
  fileTabs: {
    display: 'flex',
    gap: '8px',
    marginBottom: '12px',
    flexWrap: 'wrap',
  },
  fileTab: {
    border: 'none',
    padding: '6px 12px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '500',
    cursor: 'pointer',
  },
  liveBanner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#e8f8f0',
    border: '1px solid #a3e4c1',
    borderRadius: '6px',
    padding: '10px 14px',
    marginBottom: '12px',
    fontSize: '13px',
    fontWeight: '500',
    color: '#1e7e4f',
  },
  pullButton: {
    backgroundColor: '#27ae60',
    color: 'white',
    border: 'none',
    padding: '6px 14px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  editor: {
    width: '100%',
    height: '350px',
    padding: '12px',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontFamily: 'monospace',
    fontSize: '13px',
    lineHeight: '1.6',
    resize: 'vertical',
    boxSizing: 'border-box',
    marginBottom: '16px',
  },
  pushButton: {
    backgroundColor: '#3d5a80',
    color: 'white',
    padding: '12px 24px',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    alignSelf: 'flex-start',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '400px',
    color: '#999',
  },
  emptyIcon: {
    fontSize: '48px',
    margin: '0 0 12px 0',
  },
  emptyText: {
    fontSize: '16px',
    fontWeight: '500',
  },
  errorBanner: {
    marginTop: '20px',
    backgroundColor: '#fadbd8',
    border: '1px solid #e74c3c',
    borderRadius: '6px',
    padding: '12px 16px',
    color: '#c0392b',
    fontSize: '13px',
  },
};
