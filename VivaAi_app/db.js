// ============================================================================
// VivaAI High-Performance Database Layer (Bun SQLite + Hybrid Fallback)
// Fast, single-file, zero-dependency database designed for 350+ viva examinations
// ============================================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SQLITE_FILE = path.join(DATA_DIR, 'viva.sqlite');

let sqliteDb = null;
let isBun = false;

try {
  if (typeof Bun !== 'undefined' || process.versions.bun) {
    const { Database } = require('bun:sqlite');
    sqliteDb = new Database(SQLITE_FILE, { create: true });
    // Enable WAL (Write-Ahead-Logging) for concurrent readers & writers
    sqliteDb.run('PRAGMA journal_mode = WAL;');
    sqliteDb.run('PRAGMA synchronous = NORMAL;');
    isBun = true;
    console.log('[Database Engine] Initialized Bun Native SQLite at:', SQLITE_FILE);
  }
} catch (err) {
  console.warn('[Database Engine] Bun SQLite not available in current runtime, using JSON file fallback:', err.message);
  sqliteDb = null;
  isBun = false;
}

// ----------------------------------------------------------------------------
// JSON FALLBACK HELPERS
// ----------------------------------------------------------------------------
function readJson(filename, fallback = []) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.warn(`[DB JSON Read Error] ${filename}:`, err.message);
  }
  return fallback;
}

function writeJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[DB JSON Write Error] ${filename}:`, err.message);
  }
}

// ----------------------------------------------------------------------------
// TABLE SCHEMAS & INITIALIZATION
// ----------------------------------------------------------------------------
function initTables() {
  if (!sqliteDb) return;

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      clerk_id TEXT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      avatar TEXT,
      role TEXT DEFAULT 'student',
      status TEXT DEFAULT 'Active',
      joined_date TEXT,
      last_login TEXT
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY,
      student_name TEXT,
      student_email TEXT,
      topic TEXT,
      score INTEGER DEFAULT 0,
      integrity_score INTEGER DEFAULT 100,
      duration TEXT,
      date TEXT,
      status TEXT DEFAULT 'Completed',
      recording_url TEXT,
      camera_recording_url TEXT,
      screen_recording_url TEXT,
      technology TEXT DEFAULT 'Python',
      difficulty TEXT DEFAULT 'Medium',
      transcripts TEXT,
      scorecard TEXT,
      feedback TEXT,
      audio_path TEXT,
      created_at TEXT
    );
  `);

  // Ensure column additions for existing SQLite databases
  try { sqliteDb.run("ALTER TABLE interviews ADD COLUMN camera_recording_url TEXT;"); } catch (e) {}
  try { sqliteDb.run("ALTER TABLE interviews ADD COLUMN screen_recording_url TEXT;"); } catch (e) {}
  try { sqliteDb.run("ALTER TABLE interviews ADD COLUMN technology TEXT DEFAULT 'Python';"); } catch (e) {}
  try { sqliteDb.run("ALTER TABLE interviews ADD COLUMN difficulty TEXT DEFAULT 'Medium';"); } catch (e) {}

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS cheating_logs (
      id TEXT PRIMARY KEY,
      student_name TEXT,
      student_email TEXT,
      session_number TEXT,
      event TEXT,
      severity TEXT,
      risk TEXT,
      details TEXT,
      time TEXT,
      timestamp TEXT
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY,
      name TEXT,
      code TEXT,
      student_count INTEGER DEFAULT 0,
      avg_score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Active'
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS feedbacks (
      id TEXT PRIMARY KEY,
      name TEXT,
      email TEXT,
      topic TEXT,
      rating INTEGER DEFAULT 5,
      comment TEXT,
      date TEXT
    );
  `);

  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS admin_whitelist (
      email TEXT PRIMARY KEY,
      added_by TEXT DEFAULT 'System',
      added_at TEXT,
      is_root INTEGER DEFAULT 0
    );
  `);

  try {
    sqliteDb.run(
      'INSERT OR IGNORE INTO admin_whitelist (email, added_by, added_at, is_root) VALUES (?, ?, ?, ?)',
      ['ghodakepravin154@gmail.com', 'Root System', new Date().toISOString(), 1]
    );
    sqliteDb.run("UPDATE users SET role = 'admin' WHERE LOWER(email) = 'ghodakepravin154@gmail.com'");
  } catch (e) {}

  // Migrate existing JSON records if SQLite tables are fresh
  migrateFromExistingJson();
}

function migrateFromExistingJson() {
  if (!sqliteDb) return;

  try {
    // 1. Users migration
    const userCount = sqliteDb.query('SELECT COUNT(*) as count FROM users;').get().count;
    if (userCount === 0) {
      const users = readJson('users.json', []);
      const insertUser = sqliteDb.prepare(`
        INSERT OR REPLACE INTO users (id, clerk_id, name, email, avatar, role, status, joined_date, last_login)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const u of users) {
        insertUser.run(
          u.id || 'usr_' + Date.now().toString(36),
          u.clerkId || null,
          u.name || 'Student',
          (u.email || '').toLowerCase().trim(),
          u.avatar || null,
          u.role || 'student',
          u.status || 'Active',
          u.joinedDate || new Date().toLocaleDateString(),
          u.lastLogin || new Date().toISOString()
        );
      }
      console.log(`[Database Migration] Imported ${users.length} users into SQLite`);
    }

    // 2. Interviews migration & sync
    const interviews = readJson('interviews.json', []);
    const insertInterview = sqliteDb.prepare(`
      INSERT OR REPLACE INTO interviews (
        id, student_name, student_email, topic, score, integrity_score,
        duration, date, status, recording_url, camera_recording_url, screen_recording_url,
        technology, difficulty, transcripts, scorecard, feedback, audio_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const iv of interviews) {
      const interviewId = iv.id || iv.sessionNumber || 'AV-' + Math.floor(1000 + Math.random() * 9000);
      const exists = sqliteDb.query('SELECT id FROM interviews WHERE id = ?').get(interviewId);
      if (!exists) {
        insertInterview.run(
          interviewId,
          iv.studentName || iv.name || 'Candidate',
          iv.studentEmail || iv.email || 'student@college.edu',
          iv.topic || 'Data Structures',
          iv.score ?? 75,
          iv.integrityScore ?? 100,
          iv.duration || '08:45',
          iv.date || new Date().toLocaleDateString(),
          iv.status || 'Completed',
          iv.recordingUrl || null,
          iv.cameraRecordingUrl || iv.camera_recording_url || null,
          iv.screenRecordingUrl || iv.screen_recording_url || null,
          iv.technology || 'Python',
          iv.difficulty || 'Medium',
          typeof iv.transcripts === 'object' ? JSON.stringify(iv.transcripts) : (iv.transcripts || '[]'),
          typeof iv.scorecard === 'object' ? JSON.stringify(iv.scorecard) : (iv.scorecard || '{}'),
          typeof iv.feedback === 'object' ? JSON.stringify(iv.feedback) : (iv.feedback || '{}'),
          iv.audioPath || null,
          iv.createdAt || new Date().toISOString()
        );
      }
    }

    // 3. Cheating Logs
    const logCount = sqliteDb.query('SELECT COUNT(*) as count FROM cheating_logs;').get().count;
    if (logCount === 0) {
      const logs = readJson('cheating_logs.json', []);
      const insertLog = sqliteDb.prepare(`
        INSERT OR REPLACE INTO cheating_logs (id, student_name, student_email, session_number, event, severity, risk, details, time, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const l of logs) {
        insertLog.run(
          l.id || 'log_' + Date.now().toString(36),
          l.studentName || 'Student',
          l.studentEmail || 'student@college.edu',
          l.sessionNumber || 'AV-0001',
          l.event || 'Integrity Check',
          l.severity || 'Medium',
          l.risk || 'Medium',
          l.details || 'Detected by proctoring engine',
          l.time || '10:00 AM',
          l.timestamp || new Date().toISOString()
        );
      }
      console.log(`[Database Migration] Imported ${logs.length} integrity logs into SQLite`);
    }

    // 4. Topics
    const topicCount = sqliteDb.query('SELECT COUNT(*) as count FROM topics;').get().count;
    if (topicCount === 0) {
      const topics = readJson('topics.json', []);
      const insertTopic = sqliteDb.prepare(`
        INSERT OR REPLACE INTO topics (id, name, code, student_count, avg_score, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const t of topics) {
        insertTopic.run(
          t.id || 'top_' + Date.now().toString(36),
          t.name || 'Engineering Subject',
          t.code || 'ENG-101',
          t.studentCount ?? 0,
          t.avgScore ?? 75,
          t.status || 'Active'
        );
      }
      console.log(`[Database Migration] Imported ${topics.length} topics into SQLite`);
    }

    // 5. Feedbacks
    const fbCount = sqliteDb.query('SELECT COUNT(*) as count FROM feedbacks;').get().count;
    if (fbCount === 0) {
      const feedbacks = readJson('feedbacks.json', []);
      const insertFb = sqliteDb.prepare(`
        INSERT OR REPLACE INTO feedbacks (id, name, email, topic, rating, comment, date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of feedbacks) {
        insertFb.run(
          f.id || 'fb_' + Date.now().toString(36),
          f.name || 'Student',
          f.email || 'student@college.edu',
          f.topic || 'General Viva',
          f.rating ?? 5,
          f.comment || 'Smooth voice viva experience',
          f.date || new Date().toLocaleDateString()
        );
      }
      console.log(`[Database Migration] Imported ${feedbacks.length} feedbacks into SQLite`);
    }
  } catch (err) {
    console.warn('[Database Migration Notice]:', err.message);
  }
}

// Initialize tables immediately
initTables();

// ----------------------------------------------------------------------------
// EXPORTED DATA ACCESS METHODS
// ----------------------------------------------------------------------------
const DB = {
  isBun,
  isSqlite: !!sqliteDb,

  // USERS
  getUsers() {
    if (sqliteDb) {
      const rows = sqliteDb.query('SELECT * FROM users ORDER BY joined_date DESC;').all();
      return rows.map(r => ({
        id: r.id,
        clerkId: r.clerk_id,
        name: r.name,
        email: r.email,
        avatar: r.avatar,
        role: r.role,
        status: r.status,
        joinedDate: r.joined_date,
        lastLogin: r.last_login
      }));
    }
    return readJson('users.json', []);
  },

  getUserByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.toLowerCase().trim();
    if (sqliteDb) {
      const r = sqliteDb.query('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1;').get(cleanEmail);
      if (!r) return null;
      return {
        id: r.id,
        clerkId: r.clerk_id,
        name: r.name,
        email: r.email,
        avatar: r.avatar,
        role: r.role,
        status: r.status,
        joinedDate: r.joined_date,
        lastLogin: r.last_login
      };
    }
    const users = readJson('users.json', []);
    return users.find(u => (u.email || '').toLowerCase() === cleanEmail) || null;
  },

  upsertUser(user) {
    const email = (user.email || '').toLowerCase().trim();
    if (!email) return null;

    const isAdmin = this.isAdminEmail(email);
    const resolvedRole = isAdmin ? 'admin' : (user.role === 'admin' ? (isAdmin ? 'admin' : 'student') : (user.role || 'student'));

    if (sqliteDb) {
      const stmt = sqliteDb.prepare(`
        INSERT INTO users (id, clerk_id, name, email, avatar, role, status, joined_date, last_login)
        VALUES ($id, $clerk_id, $name, $email, $avatar, $role, $status, $joined_date, $last_login)
        ON CONFLICT(email) DO UPDATE SET
          name = COALESCE($name, users.name),
          clerk_id = COALESCE($clerk_id, users.clerk_id),
          avatar = COALESCE($avatar, users.avatar),
          role = $role,
          last_login = $last_login
        RETURNING *;
      `);

      const saved = stmt.get({
        $id: user.id || 'usr_' + Date.now().toString(36),
        $clerk_id: user.clerkId || null,
        $name: user.name || (email.split('@')[0]),
        $email: email,
        $avatar: user.avatar || null,
        $role: resolvedRole,
        $status: user.status || 'Active',
        $joined_date: user.joinedDate || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        $last_login: user.lastLogin || new Date().toISOString()
      });

      // Keep JSON file in sync as backup
      try {
        const users = this.getUsers();
        writeJson('users.json', users);
      } catch (e) {}

      return {
        id: saved.id,
        clerkId: saved.clerk_id,
        name: saved.name,
        email: saved.email,
        avatar: saved.avatar,
        role: saved.role,
        status: saved.status,
        joinedDate: saved.joined_date,
        lastLogin: saved.last_login
      };
    }

    // JSON fallback
    const users = readJson('users.json', []);
    let existingIndex = users.findIndex(u => (u.email || '').toLowerCase() === email);
    if (existingIndex >= 0) {
      users[existingIndex] = { ...users[existingIndex], ...user, role: resolvedRole, lastLogin: new Date().toISOString() };
      writeJson('users.json', users);
      return users[existingIndex];
    } else {
      const newUser = {
        id: user.id || 'usr_' + Date.now().toString(36),
        clerkId: user.clerkId || null,
        name: user.name || (email.split('@')[0]),
        email: email,
        avatar: user.avatar || null,
        role: resolvedRole,
        status: 'Active',
        joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        lastLogin: new Date().toISOString()
      };
      users.unshift(newUser);
      writeJson('users.json', users);
      return newUser;
    }
  },

  // INTERVIEWS & RECORDINGS
  getInterviews() {
    if (sqliteDb) {
      const rows = sqliteDb.query('SELECT * FROM interviews ORDER BY created_at DESC;').all();
      return rows.map(r => ({
        id: r.id,
        sessionNumber: r.id,
        studentName: r.student_name,
        studentEmail: r.student_email,
        candidateName: r.student_name,
        candidateEmail: r.student_email,
        topic: r.topic,
        score: r.score,
        integrityScore: r.integrity_score,
        duration: r.duration,
        date: r.date,
        status: r.status,
        recordingUrl: r.recording_url,
        cameraRecordingUrl: r.camera_recording_url || null,
        screenRecordingUrl: r.screen_recording_url || null,
        technology: r.technology || 'Python',
        difficulty: r.difficulty || 'Medium',
        audioPath: r.audio_path,
        transcripts: r.transcripts ? (typeof r.transcripts === 'string' ? JSON.parse(r.transcripts) : r.transcripts) : [],
        scorecard: r.scorecard ? (typeof r.scorecard === 'string' ? JSON.parse(r.scorecard) : r.scorecard) : {},
        feedback: r.feedback ? (typeof r.feedback === 'string' ? JSON.parse(r.feedback) : r.feedback) : {},
        createdAt: r.created_at
      }));
    }
    return readJson('interviews.json', []);
  },

  getInterviewById(id) {
    if (!id) return null;
    if (sqliteDb) {
      const r = sqliteDb.query('SELECT * FROM interviews WHERE id = ? LIMIT 1;').get(id);
      if (!r) return null;
      return {
        id: r.id,
        sessionNumber: r.id,
        studentName: r.student_name,
        studentEmail: r.student_email,
        candidateName: r.student_name,
        candidateEmail: r.student_email,
        topic: r.topic,
        score: r.score,
        integrityScore: r.integrity_score,
        duration: r.duration,
        date: r.date,
        status: r.status,
        recordingUrl: r.recording_url,
        cameraRecordingUrl: r.camera_recording_url || null,
        screenRecordingUrl: r.screen_recording_url || null,
        technology: r.technology || 'Python',
        difficulty: r.difficulty || 'Medium',
        audioPath: r.audio_path,
        transcripts: r.transcripts ? (typeof r.transcripts === 'string' ? JSON.parse(r.transcripts) : r.transcripts) : [],
        scorecard: r.scorecard ? (typeof r.scorecard === 'string' ? JSON.parse(r.scorecard) : r.scorecard) : {},
        feedback: r.feedback ? (typeof r.feedback === 'string' ? JSON.parse(r.feedback) : r.feedback) : {},
        createdAt: r.created_at
      };
    }
    const list = readJson('interviews.json', []);
    return list.find(iv => iv.id === id || iv.sessionNumber === id) || null;
  },

  saveInterview(data) {
    const id = data.id || data.sessionNumber || 'AV-' + Math.floor(1000 + Math.random() * 9000);
    const rawTranscripts = data.transcripts || data.transcript || [];
    const transcriptsStr = typeof rawTranscripts === 'string' ? rawTranscripts : JSON.stringify(rawTranscripts);
    const scorecardObj = (data.scorecard && typeof data.scorecard === 'object') ? { ...data.scorecard } : {};
    if (data.rubricBreakdown && !scorecardObj.rubricBreakdown) scorecardObj.rubricBreakdown = data.rubricBreakdown;
    if (data.strengths && !scorecardObj.strengths) scorecardObj.strengths = data.strengths;
    if (data.improvements && !scorecardObj.improvements) scorecardObj.improvements = data.improvements;
    if (data.suggestions && !scorecardObj.suggestions) scorecardObj.suggestions = data.suggestions;
    if (data.annotatedTranscript && !scorecardObj.annotatedTranscript) scorecardObj.annotatedTranscript = data.annotatedTranscript;
    if (data.summary && !scorecardObj.summary) scorecardObj.summary = data.summary;
    if (data.readinessTier && !scorecardObj.readinessTier) scorecardObj.readinessTier = data.readinessTier;
    const scorecardStr = JSON.stringify(scorecardObj);
    const feedbackStr = typeof data.feedback === 'string' ? data.feedback : JSON.stringify(data.feedback || {});

    if (sqliteDb) {
      const stmt = sqliteDb.prepare(`
        INSERT INTO interviews (
          id, student_name, student_email, topic, score, integrity_score,
          duration, date, status, recording_url, camera_recording_url, screen_recording_url,
          technology, difficulty, transcripts, scorecard, feedback, audio_path, created_at
        ) VALUES (
          $id, $student_name, $student_email, $topic, $score, $integrity_score,
          $duration, $date, $status, $recording_url, $camera_recording_url, $screen_recording_url,
          $technology, $difficulty, $transcripts, $scorecard, $feedback, $audio_path, $created_at
        )
        ON CONFLICT(id) DO UPDATE SET
          score = COALESCE($score, interviews.score),
          integrity_score = COALESCE($integrity_score, interviews.integrity_score),
          status = COALESCE($status, interviews.status),
          recording_url = COALESCE($recording_url, interviews.recording_url),
          camera_recording_url = COALESCE($camera_recording_url, interviews.camera_recording_url),
          screen_recording_url = COALESCE($screen_recording_url, interviews.screen_recording_url),
          technology = COALESCE($technology, interviews.technology),
          difficulty = COALESCE($difficulty, interviews.difficulty),
          transcripts = COALESCE($transcripts, interviews.transcripts),
          scorecard = COALESCE($scorecard, interviews.scorecard),
          feedback = COALESCE($feedback, interviews.feedback),
          audio_path = COALESCE($audio_path, interviews.audio_path)
        RETURNING *;
      `);

      stmt.run({
        $id: id,
        $student_name: data.candidateName || data.studentName || data.name || 'Candidate',
        $student_email: data.candidateEmail || data.studentEmail || data.email || 'student@college.edu',
        $topic: data.topic || 'Technical Viva',
        $score: data.score ?? 75,
        $integrity_score: data.integrityScore ?? 100,
        $duration: data.duration || '08:45',
        $date: data.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        $status: data.status || 'Completed',
        $recording_url: data.recordingUrl || null,
        $camera_recording_url: data.cameraRecordingUrl || data.camera_recording_url || null,
        $screen_recording_url: data.screenRecordingUrl || data.screen_recording_url || null,
        $technology: data.technology || 'Python',
        $difficulty: data.difficulty || 'Medium',
        $transcripts: transcriptsStr,
        $scorecard: scorecardStr,
        $feedback: feedbackStr,
        $audio_path: data.audioPath || null,
        $created_at: data.createdAt || new Date().toISOString()
      });

      // Keep JSON file in sync as backup
      try {
        const all = this.getInterviews();
        writeJson('interviews.json', all);
      } catch (e) {}

      return this.getInterviewById(id);
    }

    // JSON fallback
    const list = readJson('interviews.json', []);
    const record = {
      ...data,
      id,
      sessionNumber: id,
      transcripts: typeof data.transcripts === 'string' ? JSON.parse(data.transcripts) : (data.transcripts || []),
      scorecard: typeof data.scorecard === 'string' ? JSON.parse(data.scorecard) : (data.scorecard || {}),
      feedback: typeof data.feedback === 'string' ? JSON.parse(data.feedback) : (data.feedback || {}),
      date: data.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      createdAt: data.createdAt || new Date().toISOString()
    };
    const idx = list.findIndex(item => item.id === id || item.sessionNumber === id);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...record };
    } else {
      list.unshift(record);
    }
    writeJson('interviews.json', list);
    return record;
  },

  // INTEGRITY / CHEATING LOGS
  getCheatingLogs() {
    if (sqliteDb) {
      const rows = sqliteDb.query('SELECT * FROM cheating_logs ORDER BY timestamp DESC;').all();
      return rows.map(r => ({
        id: r.id,
        interviewId: r.session_number,
        sessionNumber: r.session_number,
        studentName: r.student_name,
        studentEmail: r.student_email,
        event: r.event,
        severity: r.severity,
        risk: r.risk,
        details: r.details,
        time: r.time,
        timestamp: r.timestamp,
        reviewStatus: r.review_status || 'Needs review',
        snapshot: r.snapshot || ''
      }));
    }
    return readJson('cheating_logs.json', []);
  },

  addCheatingLog(log) {
    const id = log.id || 'log_' + Date.now().toString(36);
    const time = log.time || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const timestamp = log.timestamp || new Date().toISOString();
    const sessionNumber = log.interviewId || log.sessionNumber || 'AV-0001';
    const reviewStatus = log.reviewStatus || 'Needs review';
    const snapshot = log.snapshot || '';

    if (sqliteDb) {
      const stmt = sqliteDb.prepare(`
        INSERT OR REPLACE INTO cheating_logs (id, student_name, student_email, session_number, event, severity, risk, details, time, timestamp, review_status, snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        log.studentName || 'Candidate',
        log.studentEmail || 'student@college.edu',
        sessionNumber,
        log.event || 'Proctoring Alert',
        log.severity || log.risk || 'Medium',
        log.risk || log.severity || 'Medium',
        log.details || 'Detected by proctoring engine',
        time,
        timestamp,
        reviewStatus,
        snapshot
      );

      try {
        const logs = this.getCheatingLogs();
        writeJson('cheating_logs.json', logs);
      } catch (e) {}

      return { ...log, id, sessionNumber, interviewId: sessionNumber, time, timestamp, reviewStatus, snapshot };
    }

    const logs = readJson('cheating_logs.json', []);
    const newLog = { ...log, id, sessionNumber, interviewId: sessionNumber, time, timestamp, reviewStatus, snapshot };
    logs.unshift(newLog);
    writeJson('cheating_logs.json', logs);
    return newLog;
  },

  // TOPICS
  getTopics() {
    if (sqliteDb) {
      const rows = sqliteDb.query('SELECT * FROM topics ORDER BY name ASC;').all();
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        code: r.code,
        studentCount: r.student_count,
        avgScore: r.avg_score,
        status: r.status
      }));
    }
    return readJson('topics.json', []);
  },

  // FEEDBACKS
  getFeedbacks() {
    if (sqliteDb) {
      const rows = sqliteDb.query('SELECT * FROM feedbacks ORDER BY date DESC;').all();
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        email: r.email,
        topic: r.topic,
        rating: r.rating,
        comment: r.comment,
        date: r.date
      }));
    }
    return readJson('feedbacks.json', []);
  },

  addFeedback(fb) {
    const id = fb.id || 'fb_' + Date.now().toString(36);
    const date = fb.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    if (sqliteDb) {
      const stmt = sqliteDb.prepare(`
        INSERT INTO feedbacks (id, name, email, topic, rating, comment, date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        fb.name || 'Candidate',
        fb.email || 'student@college.edu',
        fb.topic || 'Technical Viva',
        fb.rating ?? 5,
        fb.comment || 'Smooth examination experience',
        date
      );

      try {
        const feedbacks = this.getFeedbacks();
        writeJson('feedbacks.json', feedbacks);
      } catch (e) {}

      return { ...fb, id, date };
    }

    const list = readJson('feedbacks.json', []);
    const newFb = { ...fb, id, date };
    list.unshift(newFb);
    writeJson('feedbacks.json', list);
    return newFb;
  },

  // --------------------------------------------------------------------------
  // ADMIN WHITELIST & ACCESS CONTROL
  // --------------------------------------------------------------------------
  getAdminWhitelist() {
    const rootAdmin = 'ghodakepravin154@gmail.com';
    let admins = [];

    if (sqliteDb) {
      try {
        const rows = sqliteDb.query('SELECT * FROM admin_whitelist ORDER BY is_root DESC, email ASC;').all();
        admins = rows.map(r => ({
          email: r.email,
          addedBy: r.added_by,
          addedAt: r.added_at,
          isRoot: Boolean(r.is_root)
        }));
      } catch (e) {}
    } else {
      admins = readJson('admins.json', []);
    }

    // Always ensure root admin is present
    const hasRoot = admins.some(a => (a.email || '').toLowerCase() === rootAdmin);
    if (!hasRoot) {
      const rootObj = {
        email: rootAdmin,
        addedBy: 'Root System',
        addedAt: new Date().toISOString(),
        isRoot: true
      };
      admins.unshift(rootObj);
      if (sqliteDb) {
        try {
          sqliteDb.run('INSERT OR IGNORE INTO admin_whitelist (email, added_by, added_at, is_root) VALUES (?, ?, ?, ?)', [
            rootAdmin, 'Root System', rootObj.addedAt, 1
          ]);
        } catch (e) {}
      }
      writeJson('admins.json', admins);
    }
    return admins;
  },

  isAdminEmail(email) {
    if (!email) return false;
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'ghodakepravin154@gmail.com') return true;
    const list = this.getAdminWhitelist();
    return list.some(a => (a.email || '').toLowerCase() === cleanEmail);
  },

  addAdminEmail(email, addedBy = 'Admin') {
    if (!email) return { success: false, error: 'Email is required' };
    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return { success: false, error: 'Invalid email address format' };
    }

    const list = this.getAdminWhitelist();
    if (list.some(a => (a.email || '').toLowerCase() === cleanEmail)) {
      return { success: true, message: 'Email is already an authorized administrator', admins: list };
    }

    const newAdmin = {
      email: cleanEmail,
      addedBy: addedBy || 'Admin',
      addedAt: new Date().toISOString(),
      isRoot: cleanEmail === 'ghodakepravin154@gmail.com'
    };

    if (sqliteDb) {
      try {
        sqliteDb.run(
          'INSERT OR REPLACE INTO admin_whitelist (email, added_by, added_at, is_root) VALUES (?, ?, ?, ?)',
          [cleanEmail, newAdmin.addedBy, newAdmin.addedAt, newAdmin.isRoot ? 1 : 0]
        );
        // Also update users table if user already exists
        sqliteDb.run("UPDATE users SET role = 'admin' WHERE LOWER(email) = ?", [cleanEmail]);
      } catch (e) {}
    }

    // JSON update
    const jsonList = readJson('admins.json', []);
    if (!jsonList.some(a => (a.email || '').toLowerCase() === cleanEmail)) {
      jsonList.push(newAdmin);
      writeJson('admins.json', jsonList);
    }

    // Also update users.json if present
    const users = readJson('users.json', []);
    let userModified = false;
    for (const u of users) {
      if ((u.email || '').toLowerCase() === cleanEmail) {
        u.role = 'admin';
        userModified = true;
      }
    }
    if (userModified) writeJson('users.json', users);

    return { success: true, message: `Administrator access granted to ${cleanEmail}`, admins: this.getAdminWhitelist() };
  },

  removeAdminEmail(email) {
    if (!email) return { success: false, error: 'Email is required' };
    const cleanEmail = email.toLowerCase().trim();
    if (cleanEmail === 'ghodakepravin154@gmail.com') {
      return { success: false, error: 'Primary root administrator cannot be removed' };
    }

    if (sqliteDb) {
      try {
        sqliteDb.run('DELETE FROM admin_whitelist WHERE LOWER(email) = ? AND is_root = 0', [cleanEmail]);
        // Update user's role back to student
        sqliteDb.run("UPDATE users SET role = 'student' WHERE LOWER(email) = ?", [cleanEmail]);
      } catch (e) {}
    }

    let jsonList = readJson('admins.json', []);
    jsonList = jsonList.filter(a => (a.email || '').toLowerCase() !== cleanEmail);
    writeJson('admins.json', jsonList);

    const users = readJson('users.json', []);
    let userModified = false;
    for (const u of users) {
      if ((u.email || '').toLowerCase() === cleanEmail) {
        u.role = 'student';
        userModified = true;
      }
    }
    if (userModified) writeJson('users.json', users);

    return { success: true, message: `Administrator access revoked from ${cleanEmail}`, admins: this.getAdminWhitelist() };
  }
};

module.exports = DB;
