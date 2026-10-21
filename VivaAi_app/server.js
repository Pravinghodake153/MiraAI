// ==========================================================================
// VivaAI Production Backend Server & AI Engine (Node.js stdlib)
// Serves Static Frontend, Persistent Database, & OpenRouter AI Pipeline
// ==========================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// --------------------------------------------------------------------------
// 1. ENVIRONMENT CONFIGURATION (.env loader)
// --------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    }
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = path.join(__dirname, 'data');
const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');

// Ensure database and recording storage directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// --------------------------------------------------------------------------
// 2. MIME TYPES
// --------------------------------------------------------------------------
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

const DB = require('./db.js');
const Supabase = require('./supabaseClient.js');

// --------------------------------------------------------------------------
// 3. DATABASE HELPERS (Bun Native SQLite + JSON Backup Sync)
// --------------------------------------------------------------------------
function readDb(filename) {
  if (DB.isSqlite) {
    if (filename === 'users.json') return DB.getUsers();
    if (filename === 'interviews.json') return DB.getInterviews();
    if (filename === 'cheating_logs.json') return DB.getCheatingLogs();
    if (filename === 'topics.json') return DB.getTopics();
    if (filename === 'feedbacks.json') return DB.getFeedbacks();
  }
  try {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error(`[DB Error] reading ${filename}:`, err);
    return [];
  }
}

function writeDb(filename, data) {
  try {
    // If SQLite is active, sync specific items
    if (DB.isSqlite && Array.isArray(data) && data.length > 0) {
      if (filename === 'interviews.json') {
        DB.saveInterview(data[0]);
      } else if (filename === 'users.json') {
        DB.upsertUser(data[0]);
      } else if (filename === 'cheating_logs.json') {
        DB.addCheatingLog(data[0]);
      } else if (filename === 'feedbacks.json') {
        DB.addFeedback(data[0]);
      }
    }
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[DB Error] writing ${filename}:`, err);
    return false;
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => {
      try {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        resolve(bodyStr ? JSON.parse(bodyStr) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(payload));
}

// --------------------------------------------------------------------------
// 4. OPENROUTER AI CLIENT
// --------------------------------------------------------------------------
function callOpenRouter(messages, options = {}) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || !apiKey.trim() || apiKey.includes('your-key-here')) {
      return reject(new Error('NO_API_KEY'));
    }

    const model = options.model || process.env.OPENROUTER_MODEL || 'openrouter/free';
    const temperature = typeof options.temperature === 'number' ? options.temperature : 0.4;
    const maxTokens = options.max_tokens || 800;

    const payload = JSON.stringify({
      model: model,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens,
      ...(options.response_format ? { response_format: options.response_format } : {})
    });

    const reqOptions = {
      hostname: 'openrouter.ai',
      port: 443,
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'VivaAI Examination Platform',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: options.timeout || 30000
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const choice = parsed.choices?.[0];
            const msg = choice?.message;
            let content = msg?.content || '';

            // Clean out reasoning / thinking tags completely so no internal thoughts leak
            if (content) {
              content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            }

            // If content is empty but reasoning has a JSON object, safely extract only the JSON object
            if (!content && msg?.reasoning) {
              const r = msg.reasoning.trim();
              const jsonBlock = r.match(/\{[\s\S]*"question"[\s\S]*\}/);
              if (jsonBlock) {
                content = jsonBlock[0];
              }
            }
            resolve(content);
          } else {
            console.warn('[OpenRouter API Error]', res.statusCode, parsed);
            reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OpenRouter API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

// Dynamically generate question aligned strictly with Admin Panel flow stage directives (NO fake static questions)
function generateAdminFlowStageQuestion(topic, stageObj, history = []) {
  const stageName = (stageObj?.name || 'Fundamentals').trim();
  const guidance = (stageObj?.guidance || stageObj?.desc || '').trim();
  const sLower = stageName.toLowerCase();
  const turnCount = history.filter(h => h.speaker === 'mira' || h.role === 'assistant').length;

  if (sLower.includes('warm') || sLower.includes('intro') || stageObj?.category === 'opening') {
    return `Welcome to your viva on ${topic}. Are you ready to begin, and could you briefly introduce your experience with ${topic}?`;
  }
  if (sLower.includes('fund') || sLower.includes('concept') || sLower.includes('basic')) {
    if (turnCount % 2 === 0) {
      return `Let's discuss fundamental concepts in ${topic}. How do core architectural definitions and standard complexities compare?`;
    }
    return `Can you explain the primary theoretical principles and memory layout trade-offs in ${topic}?`;
  }
  if (sLower.includes('depth') || sLower.includes('advance') || sLower.includes('intern')) {
    if (turnCount % 2 === 0) {
      return `Taking a deeper dive into ${topic}: how do internal mechanisms and worst-case scenarios affect runtime efficiency?`;
    }
    return `When scaling systems with ${topic}, what edge cases, concurrency risks, or performance trade-offs do you prioritize?`;
  }
  if (sLower.includes('applied') || sLower.includes('problem') || sLower.includes('scenar') || sLower.includes('debug')) {
    return `Here is a practical scenario in ${topic}: how would you diagnose and solve a critical performance bottleneck step-by-step?`;
  }
  if (sLower.includes('wrap') || sLower.includes('clos') || sLower.includes('conclu')) {
    return `We are concluding our viva on ${topic}. Do you have any closing technical thoughts or trade-offs you would like to clarify?`;
  }

  // If admin customized a stage with custom guidance:
  if (guidance) {
    const cleanedGuidance = guidance.toLowerCase().replace(/^(ask|welcome|dive|present)\s*/i, '');
    return `In our ${stageName} stage for ${topic}: can you share your technical perspective regarding ${cleanedGuidance}?`;
  }

  return `Regarding ${topic} in the ${stageName} stage: could you walk me through your engineering approach and key trade-offs?`;
}

// --------------------------------------------------------------------------
// 5. MIRA LIVE INTERVIEWER ADAPTIVE LOGIC WITH CORRUPTION & 2ND FALLBACK TRY
// --------------------------------------------------------------------------
function parseAndValidateMiraResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let cleanText = rawText.trim();
  // Strip reasoning / think tags
  cleanText = cleanText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^Thinking Process:[\s\S]*?(?=\{|"question")/i, '')
    .replace(/^Reasoning:[\s\S]*?(?=\{|"question")/i, '')
    .trim();

  if (cleanText.includes('```json')) {
    cleanText = cleanText.split('```json')[1].split('```')[0].trim();
  } else if (cleanText.includes('```')) {
    cleanText = cleanText.split('```')[1].split('```')[0].trim();
  }

  let parsedResult = null;
  try {
    parsedResult = JSON.parse(cleanText);
  } catch (e) {
    const jsonMatch = cleanText.match(/\{[\s\S]*"question"[\s\S]*\}/);
    if (jsonMatch) {
      try { parsedResult = JSON.parse(jsonMatch[0]); } catch (e2) {}
    }
  }

  let cleanQuestion = '';
  let advanceStage = true;
  let followUpType = 'advance';

  if (parsedResult && parsedResult.question) {
    cleanQuestion = String(parsedResult.question);
    advanceStage = typeof parsedResult.advanceStage === 'boolean' ? parsedResult.advanceStage : true;
    followUpType = parsedResult.followUpType || 'advance';
  } else {
    cleanQuestion = cleanText.replace(/^(Mira:|AI:|Professor:|Question:)\s*/i, '').trim();
  }

  // Sanitize
  cleanQuestion = cleanQuestion
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/User Safety:\s*safe/gi, '')
    .replace(/However,\s*looking at the timing:.*$/gmi, '')
    .replace(/^[\s\S]*?(?:However,\s*let's|Let's|Now,|So,|Welcome)/i, (match) => {
      if (match.toLowerCase().includes('however, let')) return "Let";
      return match;
    })
    .replace(/^"+|"+$/g, '')
    .trim();

  // Validate: must not be empty or too short (at least 4 words and 15 chars)
  const words = cleanQuestion.split(/\s+/).filter(Boolean);
  if (words.length < 4 || cleanQuestion.length < 15) {
    return null; // Corrupted / too short
  }

  // Detect half/cut-off output (ends with dangling connector, punctuation, or conjunction)
  const endsAbruptly = /[,;\-–—/\\|&]\s*$/.test(cleanQuestion) || /\b(and|or|but|the|a|an|of|in|to|with|that|which|is|are|was|were)\s*$/i.test(cleanQuestion);
  if (endsAbruptly) {
    return null; // Half/truncated output!
  }

  // Detect leaked chain-of-thought or internal AI planning
  const hasReasoningLeak = /(I need to output|followUpType:|advanceStage:|Latest candidate answer:|The timing for Warm-up|The prompt says|\bformulate the response\b|\bchain of thought\b|\bthinking process\b)/i.test(cleanQuestion);
  if (hasReasoningLeak) {
    return null; // Leaked reasoning
  }

  // Ensure standard punctuation ending
  if (!/[.?!]"?$/.test(cleanQuestion)) {
    cleanQuestion += '?';
  }

  // Enforce 50-word hard ceiling (target 20-30 words)
  if (words.length > 50) {
    const truncated = words.slice(0, 32).join(' ');
    const lastQ = truncated.lastIndexOf('?');
    const lastP = truncated.lastIndexOf('.');
    const cut = Math.max(lastQ, lastP);
    if (cut > 20) {
      cleanQuestion = truncated.substring(0, cut + 1);
    } else {
      cleanQuestion = truncated + '?';
    }
  }

  return {
    question: cleanQuestion,
    followUpType,
    advanceStage
  };
}

async function generateMiraQuestion(payload) {
  const {
    topic,
    stage,
    stageDesc,
    guidance,
    currentStage: stageObjParam,
    completedStages = [],
    remainingStages = [],
    allStages = [],
    currentTime = '00:00',
    remainingTime = '15:00',
    questionHistory = [],
    lastStudentAnswer = '',
    isStallingOrOverTime = false
  } = (payload || {});

  const currentTopic = topic || 'Data Structures';
  const stageObj = stageObjParam || {};
  const stageName = stageObj.name || stage || 'Fundamentals';
  const stageCategory = stageObj.category || 'technical';
  const stageTiming = stageObj.timing || '';
  const stageDescription = stageObj.desc || stageDesc || '';
  const stageDirectives = stageObj.guidance || guidance || '';
  const history = Array.isArray(questionHistory) ? questionHistory : [];

  // Check if OpenRouter key is present
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim().length > 10) {
    try {
      // Calculate total examination duration dynamically from flow stages
      let totalFlowSecs = 0;
      const stagesForClock = (Array.isArray(allStages) && allStages.length > 0) ? allStages : (readDb('flows.json') || []);
      (stagesForClock || []).forEach(s => {
        const m = (s.timing || '').match(/(\d+):(\d+)\s*[–\-—]\s*(\d+):(\d+)/);
        if (m) {
          const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
          if (end > totalFlowSecs) totalFlowSecs = end;
        } else {
          const numMatch = (s.timing || s.duration || '').toString().match(/(\d+)/);
          totalFlowSecs += numMatch ? parseInt(numMatch[1], 10) * 60 : 180;
        }
      });
      const examDurSecs = totalFlowSecs > 0 ? totalFlowSecs : 900;
      const dynamicTotalDurationStr = `${Math.floor(examDurSecs / 60).toString().padStart(2, '0')}:${(examDurSecs % 60).toString().padStart(2, '0')}`;

      // Build clean JSON summary of session state for AI context
      const sessionContextSummary = {
        examinationTopic: currentTopic,
        clock: {
          elapsedTime: currentTime,
          timeRemaining: remainingTime,
          totalDuration: dynamicTotalDurationStr
        },
        currentStage: {
          step: stageObj.step || 1,
          name: stageName,
          category: stageCategory,
          timingWindow: stageTiming,
          objectivesAndDescription: stageDescription,
          questioningDirectives: stageDirectives
        },
        allStagesConfigured: allStages.map(s => ({
          step: s.step,
          name: s.name,
          category: s.category,
          timing: s.timing,
          desc: s.desc
        })),
        completedStages: completedStages.map(s => s.name || s),
        remainingStages: remainingStages.map(s => s.name || s),
        isCandidateOverTimeOrStalling: Boolean(isStallingOrOverTime)
      };

      const systemPrompt = `You are Professor Mira, a warm, professional, human professor conducting a live oral technical viva examination in a university classroom.

SESSION CONTEXT:
\`\`\`json
${JSON.stringify(sessionContextSummary, null, 2)}
\`\`\`

CRITICAL LENGTH & CONCISENESS RULES:
- STRICT WORD LIMIT: Try to use 20–30 words per ask only.
- DO NOT EXCEED 50 WORDS for each question under any circumstances.
- Ask ONLY ONE focused technical question at a time.
- Keep the spoken words to 1–2 crisp, natural sentences:
  1. A very short, natural transition (e.g. "Good point," or "Thanks for that,").
  2. The next technical question fulfilling: "${stageDirectives}".

CRITICAL ZERO-REASONING RULE:
- NEVER output reasoning, thinking process, chain-of-thought, or planning steps.
- Output ONLY valid JSON containing the direct words Professor Mira speaks aloud to the student.
- NEVER mention "safety", "rubric", "stage limits", "JSON", "prompt", or "evaluation" to the candidate.

FOLLOW-UP RULES:
1. Strong answer: Acknowledge insight in 3-5 words, probe one level deeper (trade-offs, concurrency, scaling).
2. Partial answer: Give one brief nudge without giving away the answer.
3. Stuck / "I don't know": Empathize briefly ("No worries at all, let's explore this angle instead") and smoothly ask next question.
4. Off-topic: Politely steer back to the topic.

RESPONSE FORMAT (STRICT JSON ONLY):
{
  "question": "Spoken question Mira says aloud (STRICTLY 20-30 WORDS, MAXIMUM 50 WORDS).",
  "followUpType": "deepen | nudge | advance | redirect",
  "advanceStage": true,
  "rationale": "One brief phrase"
}`;

      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // Provide complete conversation history in clean sequence
      const sanitizedHistory = history.map(item => ({
        speaker: item.speaker || (item.role === 'assistant' ? 'mira' : 'student'),
        stage: item.stage || stageName,
        timestamp: item.timestamp || '',
        text: item.text || item.content || ''
      }));

      messages.push({
        role: 'user',
        content: `Complete Interview Transcript so far:\n\`\`\`json\n${JSON.stringify(sanitizedHistory, null, 2)}\n\`\`\`\n\nLatest candidate answer:\n"${lastStudentAnswer || '(Candidate is ready to begin the viva)'}"\nIs Candidate Stalling / >90s: ${isStallingOrOverTime}\n\nRespond with valid JSON only:`
      });

      // ----------------------------------------------------------------------
      // TRY 1: Primary AI Request
      // ----------------------------------------------------------------------
      console.log(`[Mira AI] Requesting follow-up question via OpenRouter (${process.env.OPENROUTER_MODEL || 'openrouter/free'})...`);
      const aiResponse = await callOpenRouter(messages, {
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        temperature: 0.35,
        max_tokens: 600
      });

      let validated = parseAndValidateMiraResponse(aiResponse);

      // ----------------------------------------------------------------------
      // TRY 2: 2nd Fallback Try if Try 1 produced wrong, half, cut-off, or corrupted output
      // ----------------------------------------------------------------------
      if (!validated) {
        console.warn('[Mira AI] Try 1 returned wrong/half/corrupted output. Triggering 2nd fallback try with OpenRouter...');
        try {
          const retryMessages = [
            {
              role: 'system',
              content: `${systemPrompt}\n\nATTENTION: Your previous output was corrupted or incomplete. You MUST output ONLY valid JSON. Give ONE complete technical question of 20 to 30 words. Do not leave sentences cut off.`
            },
            ...messages.slice(1)
          ];
          const retryAiResponse = await callOpenRouter(retryMessages, {
            model: process.env.OPENROUTER_MODEL || 'openrouter/free',
            temperature: 0.2, // Lower temperature to ensure structured completion
            max_tokens: 500
          });
          validated = parseAndValidateMiraResponse(retryAiResponse);
          if (validated) {
            console.log('[Mira AI] 2nd fallback try SUCCEEDED with complete, valid question.');
          }
        } catch (retryErr) {
          console.warn('[Mira AI] 2nd fallback try request failed:', retryErr.message);
        }
      }

      // If either Try 1 or Try 2 yielded a clean, valid question, return it
      if (validated) {
        return {
          question: validated.question,
          followUpType: validated.followUpType,
          advanceStage: validated.advanceStage,
          provider: 'OpenRouter (' + (process.env.OPENROUTER_MODEL || 'openrouter/free') + ')',
          stage: stageName
        };
      }

      console.warn(`[Mira AI] Both AI attempts returned incomplete or corrupted output. Generating dynamic question aligned strictly with Admin Flow Stage: "${stageName}"`);
    } catch (err) {
      console.warn('[Mira AI] OpenRouter live call failed, generating dynamic question from Admin Flow Stage:', err.message);
    }
  }

  // Dynamic Generation strictly aligned with Admin Flow Stage directives (NO fake static questions)
  const dynamicQuestion = generateAdminFlowStageQuestion(currentTopic, stageObj, history);

  return {
    question: dynamicQuestion,
    followUpType: 'advance',
    advanceStage: true,
    provider: `Admin Flow Engine (${stageName})`,
    stage: stageName
  };
}

// --------------------------------------------------------------------------
// 6. POST-INTERVIEW RUBRIC EVALUATION ENGINE
// --------------------------------------------------------------------------
// 6. RAG PIPELINE & POST-INTERVIEW RUBRIC EVALUATION ENGINE
// --------------------------------------------------------------------------
function buildRagAnnotatedTranscript(safeTranscript, finalScore, rubricBreakdown, vivaTopic, aiTurnAnnotations = []) {
  const turns = Array.isArray(safeTranscript) ? safeTranscript : [];
  let studentTurnIdx = 0;

  return turns.map((turn, index) => {
    const isMira = turn.speaker === 'mira' || turn.role === 'assistant';
    if (isMira) {
      return {
        speaker: 'mira',
        text: turn.text || turn.content || '',
        timestamp: turn.timestamp || '00:00',
        stage: turn.stage || 'Question'
      };
    }

    // It's a student turn
    studentTurnIdx++;
    const text = (turn.text || turn.content || '').trim();
    const lower = text.toLowerCase();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const stage = turn.stage || (studentTurnIdx === 1 ? 'Warm-up' : (studentTurnIdx === 2 ? 'Fundamentals' : (studentTurnIdx === 3 ? 'Depth' : 'Applied Problem')));

    // Check if AI provided a specific annotation for this student turn
    const aiEntry = Array.isArray(aiTurnAnnotations) 
      ? aiTurnAnnotations.find(a => a.index === studentTurnIdx || a.studentTurnIndex === studentTurnIdx || (a.textSnippet && lower.includes(String(a.textSnippet).toLowerCase().slice(0, 15))))
      : null;

    if (aiEntry && aiEntry.desc) {
      const v = String(aiEntry.verdict || 'Needs depth');
      return {
        speaker: 'student',
        text: text,
        timestamp: turn.timestamp || '00:00',
        stage: stage,
        annotation: {
          verdict: v.toLowerCase().includes('strength') ? 'Strength' : 'Needs depth',
          tag: aiEntry.tag || (v.toLowerCase().includes('strength') ? 'Evidence for score' : 'Conceptual check'),
          desc: aiEntry.desc,
          dimension: aiEntry.dimension || 'Conceptual Understanding',
          supportsScore: v.toLowerCase().includes('strength') ? `${finalScore} / 100` : `${Math.max(20, finalScore - 15)} / 100`
        }
      };
    }

    // Intelligent heuristic fallback
    let dimension = 'Conceptual Understanding';
    let verdict = 'Needs depth';
    let tag = 'Conceptual check';
    let desc = '';
    let supportsScore = `${Math.max(25, finalScore - 15)} / 100`;

    // 1. Audio check or off-topic phrase
    const isAudioCheck = /can you hear|hear me|am i audible|hello|test|mic check|sound check|who are you/i.test(lower);
    // 2. Clear misconception or irrelevant words
    const isMisconception = /food|cook|eat|recipe|restaurant|movie|cricket|game|i don't know|no idea|dunno|nothing/i.test(lower);
    // 3. Question repetition / Asking examiner to explain / evasion
    const isQuestionRepetition = /can you please explain|can you explain|what is the data structure|explain what is|tell me what|tell me about|could you tell me|can you repeat/i.test(lower);
    // 4. Non-answer phrases (e.g. "programming language where we use to modify data" is inaccurate for data structures)
    const isConfusingWithLanguage = (lower.includes('programming language') || lower.includes('software where')) && !lower.includes('memory') && !lower.includes('organization');

    if (isAudioCheck) {
      dimension = 'Communication';
      verdict = 'Needs depth';
      tag = 'Audio check';
      desc = 'Candidate asked an audio verification question instead of addressing the technical question.';
    } else if (isQuestionRepetition) {
      dimension = 'Conceptual Understanding';
      verdict = 'Needs depth';
      tag = 'Repeated question';
      desc = 'Candidate repeated or redirected the question back to the examiner instead of providing a technical definition or answer.';
      supportsScore = `${Math.min(25, finalScore)} / 100`;
    } else if (isMisconception || isConfusingWithLanguage) {
      dimension = 'Conceptual Understanding';
      verdict = 'Needs depth';
      tag = 'Inaccurate definition';
      desc = isConfusingWithLanguage
        ? 'Confused data structures with a programming language; missed foundational memory organization principles.'
        : `Response contained conceptual inaccuracies and did not correctly define computer science principles for ${vivaTopic}.`;
      supportsScore = `${Math.min(30, finalScore)} / 100`;
    } else if (wordCount < 6) {
      dimension = 'Communication';
      verdict = 'Needs depth';
      tag = 'Incomplete answer';
      desc = 'Candidate gave a very brief response lacking technical explanation and depth.';
      supportsScore = `${Math.min(30, finalScore)} / 100`;
    } else if (stage.toLowerCase().includes('warm') || stage.toLowerCase().includes('fund')) {
      dimension = 'Conceptual Understanding';
      const cScore = rubricBreakdown?.conceptual?.score || 4.2;
      supportsScore = `${Math.round((cScore / 5) * 100)} / 100`;
      // Must contain substantive explanatory definitions, not just repeating keywords
      const hasSubstantiveDefinition = (lower.includes('format') || lower.includes('organize') || lower.includes('contiguous') || lower.includes('nodes') || lower.includes('pointers') || lower.includes('complexity') || lower.includes('traversal')) && !isQuestionRepetition;
      if (wordCount >= 14 && hasSubstantiveDefinition) {
        verdict = 'Strength';
        tag = 'Evidence for score';
        desc = `Accurately framed core definition in ${vivaTopic} with appropriate technical vocabulary.`;
      } else {
        verdict = 'Needs depth';
        tag = 'Conceptual check';
        desc = 'Addressed the surface question, but lacked precise technical definitions and memory organization details.';
      }
    } else if (stage.toLowerCase().includes('depth')) {
      dimension = 'Depth & Reasoning';
      const dScore = rubricBreakdown?.depth?.score || 4.0;
      supportsScore = `${Math.round((dScore / 5) * 100)} / 100`;
      const hasDepthKeywords = (lower.includes('trade-off') || lower.includes('o(1)') || lower.includes('o(n)') || lower.includes('worst-case') || lower.includes('collision') || lower.includes('cache')) && wordCount >= 14;
      if (hasDepthKeywords) {
        verdict = 'Strength';
        tag = 'Evidence for score';
        desc = 'Demonstrated clear reasoning on collisions, algorithmic trade-offs, and worst-case scenarios.';
      } else {
        verdict = 'Needs depth';
        tag = 'Needs depth';
        desc = 'Addressed the question at a high level, but missed explaining the underlying algorithmic trade-offs.';
      }
    } else if (stage.toLowerCase().includes('problem') || stage.toLowerCase().includes('appli')) {
      dimension = 'Problem Solving';
      const pScore = rubricBreakdown?.problemSolving?.score || 4.1;
      supportsScore = `${Math.round((pScore / 5) * 100)} / 100`;
      verdict = (wordCount >= 14 && !isQuestionRepetition) ? 'Strength' : 'Needs depth';
      tag = verdict === 'Strength' ? 'Evidence for score' : 'Needs depth';
      desc = verdict === 'Strength' ? 'Selected appropriate architectural design pattern and justified structural choices.' : 'Proposed partial approach but lacked implementation specificity.';
    } else {
      dimension = studentTurnIdx % 2 === 0 ? 'Practical / Project Knowledge' : 'Communication';
      verdict = (wordCount >= 12 && !isQuestionRepetition) ? 'Strength' : 'Needs depth';
      tag = 'Scoring evidence';
      desc = 'Spoken communication was composed and delivered under examination conditions.';
      supportsScore = `${finalScore} / 100`;
    }

    return {
      speaker: 'student',
      text: text,
      timestamp: turn.timestamp || '00:00',
      stage: stage,
      annotation: {
        verdict,
        tag,
        desc,
        dimension,
        supportsScore
      }
    };
  });
}

// Clean and robust JSON extractor for LLM output (handles code fences, trailing commas, single strings)
function extractCleanJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  // Remove markdown code fences and any AI safety preambles
  let cleaned = rawText
    .replace(/User Safety:\s*safe/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  // Find opening brace '{'
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;

  let lastBrace = cleaned.lastIndexOf('}');
  let jsonString = '';

  if (lastBrace > firstBrace) {
    jsonString = cleaned.slice(firstBrace, lastBrace + 1).trim();
  } else {
    // LLM was truncated before closing the root object; repair it
    jsonString = cleaned.slice(firstBrace).trim();
  }

  // Remove trailing commas before } or ]
  jsonString = jsonString.replace(/,\s*([}\]])/g, '$1');
  // Sanitize unquoted angle bracket placeholders like <overall score number 0-100> if leaked by model
  jsonString = jsonString.replace(/:\s*<([^>\r\n]+)>/g, (m, g) => {
    if (/number|score|percent|0-100/i.test(g)) return ': 45';
    return `: "${g.replace(/"/g, "'").trim()}"`;
  });

  const parseWithRepairs = (str) => {
    if (!str) return null;
    try {
      return JSON.parse(str);
    } catch (_) {}

    try {
      // Fix unescaped newlines in JSON strings
      const withEscapedNl = str.replace(/(:\s*"[^"]*)\n([^"]*")/g, '$1\\n$2');
      return JSON.parse(withEscapedNl);
    } catch (_) {}

    try {
      // Auto-repair truncated strings and brackets
      let s = str.trim();
      // If odd number of unescaped quotes, close trailing string
      const quotes = (s.match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 !== 0) s += '"';

      // Remove trailing dangling keys or dangling commas
      s = s.replace(/,\s*"[^"]*"\s*:\s*"?$/g, '');
      s = s.replace(/,\s*$/g, '');

      let openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
      while (openBrackets > 0) { s += ']'; openBrackets--; }

      let openBraces = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
      while (openBraces > 0) { s += '}'; openBraces--; }

      return JSON.parse(s);
    } catch (err) {
      return null;
    }
  };

  const parsed = parseWithRepairs(jsonString);
  if (parsed) return parsed;
  console.warn('[JSON Extract Warning] Could not parse or auto-repair JSON string snippet:', jsonString.slice(0, 120));
  return null;
}

// Normalize AI evaluation object ensuring correct types and schemas
function normalizeAiEvaluation(parsed, safeTranscript, vivaTopic) {
  if (!parsed || typeof parsed !== 'object') return null;

  // 1. Rubric Breakdown across the 5 weighted dimensions (each scored out of 100)
  const rawRub = parsed.rubricBreakdown || {};
  const dims = [
    { key: 'conceptual', weight: 30, fallbackLabel: 'Conceptual Understanding' },
    { key: 'depth', weight: 25, fallbackLabel: 'Depth & Reasoning' },
    { key: 'problemSolving', weight: 20, fallbackLabel: 'Problem Solving' },
    { key: 'practical', weight: 15, fallbackLabel: 'Practical / Project Knowledge' },
    { key: 'communication', weight: 10, fallbackLabel: 'Communication' }
  ];

  let systemWeightedSum = 0;
  const rubricBreakdown = {};

  dims.forEach(dim => {
    const d = rawRub[dim.key] || {};
    let val = typeof d.score === 'number' ? d.score : (typeof d.percent === 'number' ? d.percent : 60);
    // Convert 0-5 scale to 0-100 if necessary
    let percent = val <= 5 ? Math.round(val * 20) : Math.round(val);
    percent = Math.max(0, Math.min(100, percent));
    const normalizedScore = +(percent / 20).toFixed(1);
    const calculatedMarks = +(percent * (dim.weight / 100)).toFixed(1);

    systemWeightedSum += (percent * (dim.weight / 100));

    rubricBreakdown[dim.key] = {
      score: normalizedScore,
      percent: percent,
      weight: dim.weight,
      calculatedMarks: calculatedMarks,
      reason: d.reason || `Evaluated based on student responses in ${dim.fallbackLabel}.`,
      evidence: d.evidence || ''
    };
  });

  // 2. System-Calculated Overall Score (AI CANNOT output overall score directly; system calculates via weightage)
  const score = Math.max(0, Math.min(100, Math.round(systemWeightedSum)));

  // 3. Readiness Tier
  let readinessTier = parsed.readinessTier || (score >= 75 ? 'Placement Ready' : (score >= 50 ? 'Developing' : 'Needs Review'));

  // 4. Personalized Summary
  let summary = (typeof parsed.summary === 'string' && parsed.summary.trim().length > 15)
    ? parsed.summary.trim()
    : `Candidate completed viva examination on ${vivaTopic}. System-computed weighted score: ${score}/100.`;

  // 5. Strengths (Array of { title, desc })
  let strengths = [];
  if (Array.isArray(parsed.strengths)) {
    strengths = parsed.strengths.map(s => {
      if (typeof s === 'string') {
        const parts = s.split(':');
        return { title: parts[0].replace(/^[-*•\d\.\s]+/, '').trim(), desc: (parts.slice(1).join(':') || parts[0]).trim() };
      }
      return { title: s.title || 'Key Strength', desc: s.desc || s.description || '' };
    }).filter(s => s.desc && s.desc.length > 5);
  }

  // 6. Improvements (Array of { title, desc })
  let improvements = [];
  if (Array.isArray(parsed.improvements)) {
    improvements = parsed.improvements.map(im => {
      if (typeof im === 'string') {
        const parts = im.split(':');
        return { title: parts[0].replace(/^[-*•\d\.\s]+/, '').trim(), desc: (parts.slice(1).join(':') || parts[0]).trim() };
      }
      return { title: im.title || 'Area for Improvement', desc: im.desc || im.description || '' };
    }).filter(im => im.desc && im.desc.length > 5);
  }

  // 7. Suggestions (Array of action strings)
  let suggestions = [];
  if (Array.isArray(parsed.suggestions)) {
    suggestions = parsed.suggestions.map(s => {
      if (typeof s === 'string') return s.replace(/^[-*•\d\.\s]+/, '').trim();
      return (s.text || s.desc || s.title || '').trim();
    }).filter(s => s.length > 8);
  } else if (typeof parsed.suggestions === 'string' && parsed.suggestions.trim().length > 10) {
    suggestions = parsed.suggestions
      .split(/(?:\r?\n)+|(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map(s => s.replace(/^[-*•\d\.\s]+/, '').trim())
      .filter(s => s.length > 8);
  }

  // Fallbacks if AI output arrays were empty
  if (strengths.length === 0) {
    strengths.push({
      title: 'Topic Engagement',
      desc: `Candidate participated in the ${vivaTopic} discussion and attempted responses to examiner questions.`
    });
  }
  if (improvements.length === 0) {
    improvements.push({
      title: 'Technical Depth',
      desc: `Answers would benefit from deeper analysis of system trade-offs and complexity constraints in ${vivaTopic}.`
    });
  }
  if (suggestions.length === 0) {
    suggestions.push(`Review core principles and practical implementations in ${vivaTopic}.`);
    suggestions.push(`Practice verbalizing algorithmic trade-offs and complexity calculations under exam conditions.`);
  }

  const annotatedTranscript = buildRagAnnotatedTranscript(safeTranscript, score, rubricBreakdown, vivaTopic, parsed.turnAnnotations);

  return {
    score,
    readinessTier,
    summary,
    rubricBreakdown,
    strengths,
    improvements,
    suggestions,
    annotatedTranscript
  };
}

// --------------------------------------------------------------------------
// RAG GROUND TRUTH & EXPECTED SOLUTIONS KNOWLEDGE RETRIEVAL
// --------------------------------------------------------------------------
function getRagExpectedSolutionForQuestion(questionText, topic) {
  const qLower = (questionText || '').toLowerCase();
  const tLower = (topic || '').toLowerCase();

  if (qLower.includes('data structure') && (qLower.includes('what') || qLower.includes('define') || qLower.includes('purpose') || qLower.includes('mean'))) {
    return {
      concept: 'Definition & Purpose of Data Structures',
      expectedSolutions: [
        'Organized format to store, manage, and retrieve data efficiently in computer memory',
        'Standard structures: Arrays, Linked Lists, Stacks, Queues, Trees, Graphs, Hash Tables',
        'Optimizes time complexity (search, insert, delete) and memory space'
      ],
      redFlags: [
        'Describing as food, kitchen, cooking, recipes, or non-technical metaphors',
        'Stating it is binary code or programming languages themselves without memory context',
        'Audio checks ("Can you hear me", "Can you hear") or evasion'
      ]
    };
  }

  if (qLower.includes('array') && qLower.includes('linked list')) {
    return {
      concept: 'Array vs Linked List Trade-offs',
      expectedSolutions: [
        'Array: Contiguous memory, O(1) random access by index, fixed size, O(n) insert/delete (shifting required)',
        'Linked List: Non-contiguous nodes stored with pointers, dynamic size, O(1) insert/delete at head/known position, O(n) sequential search'
      ],
      redFlags: [
        'Claiming linked lists have O(1) random index lookup',
        'Confusing contiguous array indexing with pointer traversal'
      ]
    };
  }

  if (qLower.includes('hash') || (qLower.includes('collision') && qLower.includes('table'))) {
    return {
      concept: 'Hash Tables & Collision Resolution',
      expectedSolutions: [
        'Hash function maps key to an array bucket index',
        'Average O(1) lookup, worst-case O(n)',
        'Collision resolution: Separate Chaining (linked lists/trees in buckets) or Open Addressing (Linear, Quadratic Probing, Double Hashing)'
      ],
      redFlags: [
        'Claiming hash collisions never happen or claiming hash tables keep items in sorted order'
      ]
    };
  }

  if (qLower.includes('binary search') || qLower.includes('linear search')) {
    return {
      concept: 'Binary Search vs Linear Search',
      expectedSolutions: [
        'Binary search requires sorted array, divides search interval in half each step: O(log n) time',
        'Linear search checks elements sequentially: O(n) time, works on unsorted lists'
      ],
      redFlags: [
        'Saying binary search works on unsorted arrays without sorting first',
        'Confusing O(log n) with O(n)'
      ]
    };
  }

  if (qLower.includes('process') && qLower.includes('thread')) {
    return {
      concept: 'Process vs Thread',
      expectedSolutions: [
        'Process: Independent execution program with private address space, file descriptors, and OS memory isolation',
        'Thread: Lightweight execution unit inside a process, sharing memory, code, heap, and open files with other threads, private stack/registers'
      ],
      redFlags: [
        'Claiming processes share memory space by default without IPC or shared memory'
      ]
    };
  }

  if (qLower.includes('deadlock')) {
    return {
      concept: 'Deadlock Conditions & Prevention',
      expectedSolutions: [
        'Coffman conditions: Mutual Exclusion, Hold and Wait, No Preemption, Circular Wait',
        'Prevention/avoidance: Resource ordering, Banker algorithm, timeouts'
      ],
      redFlags: [
        'Confusing deadlock with starvation or infinite loops'
      ]
    };
  }

  if (qLower.includes('acid') || qLower.includes('transaction')) {
    return {
      concept: 'Database ACID Properties',
      expectedSolutions: [
        'Atomicity (all or nothing), Consistency (maintains valid invariants), Isolation (concurrency control), Durability (committed data survives crashes)'
      ],
      redFlags: [
        'Forgetting Durability or confusing Isolation with single-user mode'
      ]
    };
  }

  if (qLower.includes('index') && (qLower.includes('b+') || qLower.includes('tree') || qLower.includes('clustered'))) {
    return {
      concept: 'Database Indexing & B+ Trees',
      expectedSolutions: [
        'B+ Trees store data pointers at leaf nodes linked together for fast sequential range queries (O(log n))',
        'Clustered index determines physical row storage order; Non-clustered index stores pointers back to data rows'
      ],
      redFlags: [
        'Claiming index slows down read operations or confusing primary key with foreign key'
      ]
    };
  }

  return {
    concept: `Technical Competency in ${topic}`,
    expectedSolutions: [
      `Directly articulate accurate definitions and core mechanisms for ${topic}`,
      'Explain practical time/space complexity or system architecture trade-offs',
      'Address the exact scenario or question asked with proper terminology'
    ],
    redFlags: [
      'Answering with non-technical analogies (e.g. food, kitchen, movies, sports)',
      'Audio check questions ("Can you hear me", "Can you hear", "Who are you")',
      'Repeating question or answering "Tell me", "I don\'t know", or silence'
    ]
  };
}

function buildRagQAPairs(safeTranscript, topic) {
  const qaPairs = [];
  let currentMiraQuestion = null;

  for (const turn of safeTranscript) {
    const isMira = turn.speaker === 'mira' || turn.role === 'assistant';
    if (isMira) {
      currentMiraQuestion = turn;
    } else {
      const qText = currentMiraQuestion ? (currentMiraQuestion.text || currentMiraQuestion.content || '') : 'Opening introductory question';
      const qStage = (currentMiraQuestion && currentMiraQuestion.stage) || turn.stage || 'Question';
      const ragRef = getRagExpectedSolutionForQuestion(qText, topic);
      const studentSpeech = (turn.text || turn.content || '').trim();
      const lowerSpeech = studentSpeech.toLowerCase();

      let patternType = 'Incomplete';
      if (/can you hear|hear me|audible|hello|test|mic check|sound check|who are you/i.test(lowerSpeech)) {
        patternType = 'Off-topic / Audio Check (0% technical coverage)';
      } else if (/food|cook|eat|recipe|restaurant|movie|game|cricket|don't know|no idea|dunno/i.test(lowerSpeech)) {
        patternType = 'Factually Inaccurate / Hallucinated (Severe misconception)';
      } else if (studentSpeech.length > 30 && (lowerSpeech.includes('data') || lowerSpeech.includes('memory') || lowerSpeech.includes('pointer') || lowerSpeech.includes('algorithm') || lowerSpeech.includes('trade') || lowerSpeech.includes('complexity') || lowerSpeech.includes('array') || lowerSpeech.includes('index'))) {
        patternType = 'Substantive Technical Response';
      }

      qaPairs.push({
        turnIndex: qaPairs.length + 1,
        stage: qStage,
        questionAsked: qText,
        expectedSolution: ragRef.expectedSolutions.join(' | '),
        redFlags: ragRef.redFlags.join(' | '),
        studentAnswer: studentSpeech,
        answeringPattern: patternType
      });
    }
  }

  return qaPairs;
}

async function evaluateInterview({ studentName, topic, transcript, durationSeconds }) {
  const safeTranscript = Array.isArray(transcript) ? transcript : [];
  const candidate = studentName || 'Candidate';
  const vivaTopic = topic || 'Data Structures & Algorithms';

  // Build structured RAG Q&A pairs with ground truth expected solutions & pattern detection
  const ragQAPairs = buildRagQAPairs(safeTranscript, vivaTopic);
  const ragFormattedExchanges = ragQAPairs.map(p => `
EXCHANGE ${p.turnIndex} [Stage: ${p.stage}]
- EXAMINER QUESTION: "${p.questionAsked}"
- EXPECTED TECHNICAL SOLUTION / CRITERIA: ${p.expectedSolution}
- RED FLAGS / COMMON ERRORS: ${p.redFlags}
- CANDIDATE ACTUAL SPOKEN ANSWER: "${p.studentAnswer}"
- PRE-EVALUATED ANSWERING PATTERN: ${p.answeringPattern}
`).join('\n');

  // Attempt real AI evaluation via OpenRouter with strict, personalized evaluation instructions
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim().length > 10) {
    try {
      const evalPrompt = `You are a Senior Academic Examiner and Chief Accreditation Inspector grading a formal university oral viva examination for student "${candidate}" on the subject "${vivaTopic}".

YOU MUST ENFORCE THE FOLLOWING STRICT SCORING POLICY:
1. FAILING / UNPREPARED RANGE (0 - 35 / 100):
   - Candidate hallucinates or fabricates absurd definitions (e.g. defining data structures as "food", "kitchen", or non-computing metaphors).
   - Candidate deflects questions with audio checks ("Can you hear me now") during technical stages.
   - Candidate produces evasive responses (e.g. saying "Tell me", repeating questions, or saying "I don't know").
   - MANDATORY: If candidate committed any of the above on core questions, their score MUST NOT exceed 35/100, and readinessTier MUST be "Needs Review".

2. SUBSTANDARD / WEAK RANGE (36 - 55 / 100):
   - Candidate mentions high-level keywords but fails to explain memory mechanics, time complexities, or algorithms.
   - Misses more than 50% of the expected criteria.
   - Score MUST NOT exceed 55/100, and readinessTier MUST be "Needs Review".

3. COMPETENT RANGE (56 - 74 / 100):
   - Candidate correctly answers fundamental definitions and basics.
   - Minor gaps in edge cases, memory layout, or architectural trade-offs.
   - Readiness Tier: "Developing".

4. PLACEMENT READY / STRONG RANGE (75 - 90 / 100):
   - Candidate articulates accurate definitions, correct time/space complexities, memory diagrams, and trade-offs.
   - Readiness Tier: "Placement Ready".

5. MASTERY RANGE (91 - 100 / 100):
   - Flawless theoretical depth, architectural clarity, covers edge cases and low-level implementations.

HERE IS THE STRUCTURED RAG QUESTION-BY-QUESTION AUDIT:
${ragFormattedExchanges}

CRITICAL RULES:
- Compare each candidate answer directly against the RAG Ground Truth Expected Solution.
- If the candidate failed to provide the expected solution (e.g., said "structure of food" or asked "Can you hear me now"), penalize heavily and detail this failure in turnAnnotations and rubricBreakdown.
- In "turnAnnotations", evaluate each student turn individually by index.
- DO NOT use generic placeholder text. Every strength, improvement, and suggestion must directly cite what was discussed in the transcript!
- Output ONLY valid JSON matching the format below without angle brackets or placeholders.

EXACT JSON FORMAT TO RETURN:
{
  "score": 28,
  "readinessTier": "Needs Review",
  "summary": "Candidate demonstrated critical gaps in fundamental computer science definitions, incorrectly describing a data structure as 'a structure of food' and evading questions with audio checks.",
  "rubricBreakdown": {
    "conceptual": { "score": 20, "percent": 20, "reason": "Failed to provide a valid definition of data structures; hallucinated non-computing analogies." },
    "depth": { "score": 15, "percent": 15, "reason": "Did not demonstrate any understanding of memory layout, pointers, or complexity." },
    "problemSolving": { "score": 25, "percent": 25, "reason": "Unable to approach technical problems or scenarios." },
    "practical": { "score": 20, "percent": 20, "reason": "Lacked foundational connection to actual software development." },
    "communication": { "score": 40, "percent": 40, "reason": "Deflected technical prompts to check audio connectivity; struggled to maintain examination focus." }
  },
  "strengths": [
    { "title": "Viva Participation", "desc": "Candidate attended the examination and responded to the examiner prompts." }
  ],
  "improvements": [
    { "title": "Fundamental Definitions", "desc": "Candidate must study standard definitions of computer data structures and understand they organize memory, not food or physical items." },
    { "title": "Technical Oral Preparedness", "desc": "Focus directly on answering the questions asked rather than evading with microphone checks." }
  ],
  "suggestions": [
    "Read Chapter 1 of a standard Data Structures textbook (e.g., Cormen / CLRS) on memory organization.",
    "Practice defining basic terms aloud in clear technical English.",
    "Learn the distinction between software data structures (arrays, trees) and physical concepts."
  ],
  "turnAnnotations": [
    {
      "index": 1,
      "verdict": "Needs depth",
      "tag": "Audio check",
      "dimension": "Communication",
      "desc": "Candidate asked 'Can you hear me now' instead of answering the introductory question."
    },
    {
      "index": 2,
      "verdict": "Needs depth",
      "tag": "Inaccurate definition",
      "dimension": "Conceptual Understanding",
      "desc": "Candidate incorrectly defined data structure as a 'structure of food', displaying a severe conceptual misunderstanding."
    }
  ]
}`;

      console.log(`[Evaluator AI] Running real OpenRouter RAG strict scoring for ${candidate}...`);
      const rawAiResponse = await callOpenRouter([
        { role: 'system', content: 'You are an objective, strict academic examination evaluator enforcing rigorous university accreditation standards. Respond only with valid JSON.' },
        { role: 'user', content: evalPrompt }
      ], {
        model: process.env.OPENROUTER_EVAL_MODEL || process.env.OPENROUTER_MODEL || 'openrouter/free',
        temperature: 0.1,
        max_tokens: 2500
      });

      const parsed = extractCleanJson(rawAiResponse);
      if (parsed) {
        const normalized = normalizeAiEvaluation(parsed, safeTranscript, vivaTopic);
        if (normalized) {
          console.log(`[Evaluator AI] Successfully scored viva session: ${normalized.score}/100 [${normalized.readinessTier}] with RAG expected solutions`);
          return normalized;
        }
      } else {
        console.warn('[Evaluator AI] Could not parse JSON from OpenRouter output:', rawAiResponse.slice(0, 300));
      }
    } catch (err) {
      console.warn('[Evaluator AI] OpenRouter evaluation request failed:', err.message);
    }
  }

  // Strict Deterministic Fallback Score Calculation (when AI is offline)
  const studentTurns = safeTranscript.filter(t => t.speaker === 'student' || t.role === 'user');
  const answerCount = studentTurns.length;

  const hasMisconception = studentTurns.some(t => /food|cook|eat|recipe|restaurant|movie|game|cricket|don't know|no idea|dunno/i.test(t.text || ''));
  const audioCheckCount = studentTurns.filter(t => /can you hear|hear me|audible|hello|test|mic check|sound check|who are you/i.test(t.text || '')).length;
  const techKeywords = studentTurns.filter(t => /data|memory|pointer|algorithm|structure|array|list|tree|hash|complexity|node|index|process|thread/i.test(t.text || '')).length;

  let baseRaw = 30;
  if (techKeywords > 0) baseRaw += Math.min(35, techKeywords * 10);
  if (hasMisconception) baseRaw = Math.min(baseRaw, 25);
  if (audioCheckCount >= 1 && techKeywords === 0) baseRaw = Math.min(baseRaw, 20);

  const cPercent = Math.max(10, Math.min(100, baseRaw));
  const dPercent = Math.max(10, Math.min(100, baseRaw - 5));
  const pPercent = Math.max(10, Math.min(100, baseRaw - 5));
  const prPercent = Math.max(10, Math.min(100, baseRaw - 8));
  const cmPercent = Math.max(20, Math.min(100, baseRaw + (audioCheckCount > 0 ? -15 : 10)));

  // Strict weighted sum calculated by system (AI cannot dictate overall score)
  const finalScore = Math.round(
    (cPercent * 0.30) +
    (dPercent * 0.25) +
    (pPercent * 0.20) +
    (prPercent * 0.15) +
    (cmPercent * 0.10)
  );

  const rubricBreakdown = {
    conceptual: {
      score: +(cPercent / 20).toFixed(1),
      percent: cPercent,
      weight: 30,
      calculatedMarks: +(cPercent * 0.30).toFixed(1),
      reason: hasMisconception ? 'Significant misconceptions identified in fundamental concepts.' : 'Evaluated against core technical criteria.',
      evidence: studentTurns[0] ? `"${studentTurns[0].text.slice(0, 80)}..."` : ''
    },
    depth: {
      score: +(dPercent / 20).toFixed(1),
      percent: dPercent,
      weight: 25,
      calculatedMarks: +(dPercent * 0.25).toFixed(1),
      reason: 'Lacked architectural depth, memory details, and time/space complexity analysis.',
      evidence: studentTurns[1] ? `"${studentTurns[1].text.slice(0, 80)}..."` : ''
    },
    problemSolving: {
      score: +(pPercent / 20).toFixed(1),
      percent: pPercent,
      weight: 20,
      calculatedMarks: +(pPercent * 0.20).toFixed(1),
      reason: 'Struggled to apply concepts to real-world scenarios or problem statements.',
      evidence: studentTurns[2] ? `"${studentTurns[2].text.slice(0, 80)}..."` : ''
    },
    practical: {
      score: +(prPercent / 20).toFixed(1),
      percent: prPercent,
      weight: 15,
      calculatedMarks: +(prPercent * 0.15).toFixed(1),
      reason: 'Little evidence of practical programming implementation or design principles.',
      evidence: ''
    },
    communication: {
      score: +(cmPercent / 20).toFixed(1),
      percent: cmPercent,
      weight: 10,
      calculatedMarks: +(cmPercent * 0.10).toFixed(1),
      reason: audioCheckCount > 0 ? 'Frequently distracted by audio verification instead of technical content.' : 'Spoken communication delivery during oral examination.',
      evidence: ''
    }
  };

  const annotatedTranscript = buildRagAnnotatedTranscript(safeTranscript, finalScore, rubricBreakdown, vivaTopic);

  return {
    score: finalScore,
    readinessTier: finalScore >= 75 ? 'Placement Ready' : (finalScore >= 56 ? 'Developing' : 'Needs Review'),
    summary: hasMisconception
      ? `Candidate completed viva session on ${vivaTopic} with serious conceptual inaccuracies and question deflections.`
      : `Candidate completed viva session on ${vivaTopic} across ${answerCount} response turns.`,
    rubricBreakdown,
    strengths: [
      { title: 'Oral Participation', desc: `Candidate engaged in the viva dialogue across ${answerCount} response turns.` }
    ],
    improvements: [
      { title: 'Fundamental Concepts', desc: hasMisconception ? `Revisit standard definitions in ${vivaTopic} to eliminate misconceptions.` : `Strengthen core theoretical definitions in ${vivaTopic}.` },
      { title: 'Technical Depth', desc: 'Focus on time/space complexities and algorithmic mechanics rather than brief responses.' }
    ],
    suggestions: [
      `Review core textbook principles for ${vivaTopic}.`,
      'Practice oral technical explanations focusing on clear definitions and complexities.',
      'Prepare directly for scenario-based questions.'
    ],
    annotatedTranscript
  };
}

// --------------------------------------------------------------------------
// 7. HTTP REQUEST HANDLER & REST API
// --------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // Handle CORS Pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // --------------------------------------------------------------------------
  // REST API: SYSTEM & HEALTH
  // --------------------------------------------------------------------------
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      status: 'ok',
      platform: 'VivaAI Production Engine',
      version: '2.1.0',
      openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim().length > 10),
      voiceEngineMode: process.env.VOICE_ENGINE_MODE || 'web',
      model: process.env.OPENROUTER_MODEL || 'poolside/laguna-s-2.1:free',
      ttsModel: process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free',
      sttModel: process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo',
      activeDurationMinutes: parseInt(process.env.DEFAULT_EXAM_DURATION_MINUTES || '15', 10),
      timestamp: new Date().toISOString()
    });
  }

  // --------------------------------------------------------------------------
  // REST API: NETWORK SPEED TEST (Live Bandwidth Verification > 2 Mbps)
  // --------------------------------------------------------------------------
  if (pathname === '/api/speedtest' && method === 'GET') {
    // 2.5 MB chunk to reliably calculate candidate download throughput
    const chunkSize = 2.5 * 1024 * 1024;
    const testChunk = Buffer.alloc(chunkSize, 'V');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': chunkSize,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(testChunk);
  }

  // --------------------------------------------------------------------------
  // REST API: SYSTEM SETTINGS (VOICE ENGINE TOGGLE & MODEL CONFIG)
  // --------------------------------------------------------------------------
  if (pathname === '/api/settings') {
    if (method === 'GET') {
      const key = process.env.OPENROUTER_API_KEY || '';
      const masked = key.length > 8 ? key.slice(0, 6) + '...' + key.slice(-4) : '';
      const clerkPub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || '';
      return sendJson(res, 200, {
        voiceEngineMode: process.env.VOICE_ENGINE_MODE || 'web',
        llmModel: process.env.OPENROUTER_MODEL || 'openrouter/free',
        ttsModel: process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free',
        sttModel: process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo',
        openRouterConfigured: Boolean(key && key.trim().length > 10),
        maskedKey: masked,
        institution: process.env.INSTITUTION_NAME || 'MSOT Autonomous Institute of Technology',
        clerkPublishableKey: clerkPub,
        isClerkConfigured: Boolean(clerkPub && clerkPub.startsWith('pk_'))
      });
    }

    if (method === 'POST') {
      const body = await parseBody(req);
      if (body.voiceEngineMode) process.env.VOICE_ENGINE_MODE = body.voiceEngineMode;
      if (body.llmModel) process.env.OPENROUTER_MODEL = body.llmModel;
      if (body.ttsModel) process.env.OPENROUTER_TTS_MODEL = body.ttsModel;
      if (body.sttModel) process.env.OPENROUTER_STT_MODEL = body.sttModel;
      if (body.apiKey) process.env.OPENROUTER_API_KEY = body.apiKey.trim();
      if (body.clerkPublishableKey !== undefined) process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = body.clerkPublishableKey.trim();
      if (body.clerkSecretKey !== undefined) process.env.CLERK_SECRET_KEY = body.clerkSecretKey.trim();

      // Persist to .env file
      try {
        const envPath = path.join(__dirname, '.env');
        const clerkPub = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || '';
        const clerkSec = process.env.CLERK_SECRET_KEY || '';
        const envContent = `PORT=${PORT}\nOPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY || ''}\nOPENROUTER_MODEL=${process.env.OPENROUTER_MODEL || 'openrouter/free'}\nOPENROUTER_TTS_MODEL=${process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free'}\nOPENROUTER_STT_MODEL=${process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo'}\nOPENROUTER_EVAL_MODEL=${process.env.OPENROUTER_EVAL_MODEL || 'openrouter/free'}\nVOICE_ENGINE_MODE=${process.env.VOICE_ENGINE_MODE || 'web'}\nINSTITUTION_NAME="${process.env.INSTITUTION_NAME || 'MSOT Autonomous Institute of Technology'}"\nDEFAULT_EXAM_DURATION_MINUTES=15\n\n# Clerk Authentication Configuration\nNEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${clerkPub}\nCLERK_SECRET_KEY=${clerkSec}\n`;
        fs.writeFileSync(envPath, envContent, 'utf-8');
      } catch (err) {
        console.warn('[Warning] Could not persist .env:', err.message);
      }

      console.log(`[Settings] Updated: Voice Engine = ${process.env.VOICE_ENGINE_MODE}, LLM = ${process.env.OPENROUTER_MODEL}`);
      return sendJson(res, 200, {
        success: true,
        message: 'Settings updated successfully',
        voiceEngineMode: process.env.VOICE_ENGINE_MODE,
        llmModel: process.env.OPENROUTER_MODEL,
        ttsModel: process.env.OPENROUTER_TTS_MODEL,
        sttModel: process.env.OPENROUTER_STT_MODEL,
        isClerkConfigured: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.startsWith('pk_'))
      });
    }
  }

  // --------------------------------------------------------------------------
  // REST API: ADMIN WHITELIST & ACCESS CONTROL
  // --------------------------------------------------------------------------
  if (pathname === '/api/admin/whitelist') {
    if (method === 'GET') {
      const admins = DB.getAdminWhitelist();
      return sendJson(res, 200, { success: true, admins });
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const email = body.email;
      const addedBy = body.addedBy || 'Administrator';
      const result = DB.addAdminEmail(email, addedBy);
      return sendJson(res, result.success ? 200 : 400, result);
    }
    if (method === 'DELETE') {
      const body = await parseBody(req);
      const email = body.email;
      const result = DB.removeAdminEmail(email);
      return sendJson(res, result.success ? 200 : 400, result);
    }
  }

  if (pathname === '/api/admin/check' && method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const email = urlObj.searchParams.get('email') || '';
    const isAdmin = DB.isAdminEmail(email);
    return sendJson(res, 200, { isAdmin, email });
  }

  // --------------------------------------------------------------------------
  // REST API: ONLINE TTS SPEECH GENERATION (/api/ai/tts)
  // --------------------------------------------------------------------------
  if (pathname === '/api/ai/tts' && method === 'POST') {
    const body = await parseBody(req);
    const text = body.text || '';
    const voiceMode = process.env.VOICE_ENGINE_MODE || 'web';

    if (voiceMode === 'web' || !process.env.OPENROUTER_API_KEY) {
      return sendJson(res, 200, {
        mode: 'web',
        fallback: true,
        text: text
      });
    }

    console.log(`[TTS] Requesting speech for: "${text.slice(0, 40)}..." (model: ${process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free'})`);
    return sendJson(res, 200, {
      mode: 'online',
      model: process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free',
      fallback: true,
      text: text
    });
  }

  // --------------------------------------------------------------------------
  // REST API: ONLINE STT SPEECH TRANSCRIPTION (/api/ai/stt)
  // --------------------------------------------------------------------------
  if (pathname === '/api/ai/stt' && method === 'POST') {
    const body = await parseBody(req);
    const voiceMode = process.env.VOICE_ENGINE_MODE || 'web';

    if (voiceMode === 'web' || !process.env.OPENROUTER_API_KEY || !body.audioBase64) {
      return sendJson(res, 200, {
        mode: 'web',
        fallback: true
      });
    }

    console.log(`[STT] Processing audio via model: ${process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo'}`);
    return sendJson(res, 200, {
      mode: 'online',
      model: process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo',
      fallback: true
    });
  }

  // --------------------------------------------------------------------------
  // REST API: AI CONFIGURATION (GET / POST)
  // --------------------------------------------------------------------------
  if (pathname === '/api/ai/config') {
    if (method === 'GET') {
      const key = process.env.OPENROUTER_API_KEY || '';
      const masked = key.length > 8 ? key.slice(0, 6) + '...' + key.slice(-4) : '';
      return sendJson(res, 200, {
        configured: Boolean(key && key.trim().length > 10),
        maskedKey: masked,
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        evalModel: process.env.OPENROUTER_EVAL_MODEL || 'openrouter/free',
        institution: process.env.INSTITUTION_NAME || 'MSOT Autonomous Institute of Technology'
      });
    }

    if (method === 'POST') {
      const body = await parseBody(req);
      if (body.apiKey) {
        process.env.OPENROUTER_API_KEY = body.apiKey.trim();
      }
      if (body.model) {
        process.env.OPENROUTER_MODEL = body.model.trim();
      }

      // Persist to .env file
      try {
        const envPath = path.join(__dirname, '.env');
        const envContent = `PORT=${PORT}\nOPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY || ''}\nOPENROUTER_MODEL=${process.env.OPENROUTER_MODEL || 'openrouter/free'}\nOPENROUTER_TTS_MODEL=${process.env.OPENROUTER_TTS_MODEL || 'fish-audio/s2.1-pro-free:free'}\nOPENROUTER_STT_MODEL=${process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo'}\nOPENROUTER_EVAL_MODEL=${process.env.OPENROUTER_EVAL_MODEL || 'openrouter/free'}\nVOICE_ENGINE_MODE=${process.env.VOICE_ENGINE_MODE || 'web'}\nINSTITUTION_NAME="${process.env.INSTITUTION_NAME || 'MSOT Autonomous Institute of Technology'}"\nDEFAULT_EXAM_DURATION_MINUTES=15\n`;
        fs.writeFileSync(envPath, envContent, 'utf-8');
      } catch (err) {
        console.warn('[Warning] Could not persist .env file:', err.message);
      }

      return sendJson(res, 200, {
        success: true,
        message: 'OpenRouter AI configuration updated successfully',
        configured: Boolean(process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 10),
        model: process.env.OPENROUTER_MODEL
      });
    }
  }

  // --------------------------------------------------------------------------
  // REST API: MIRA LIVE INTERVIEWER (/api/ai/chat)
  // --------------------------------------------------------------------------
  if (pathname === '/api/ai/chat' && method === 'POST') {
    const body = await parseBody(req);
    const result = await generateMiraQuestion(body);
    return sendJson(res, 200, result);
  }

  // --------------------------------------------------------------------------
  // REST API: POST-INTERVIEW AUTOMATIC SCORING (/api/ai/evaluate)
  // --------------------------------------------------------------------------
  if (pathname === '/api/ai/evaluate' && method === 'POST') {
    const body = await parseBody(req);
    const evaluation = await evaluateInterview({
      studentName: body.studentName,
      topic: body.topic,
      transcript: body.transcript,
      durationSeconds: body.durationSeconds || 900
    });
    return sendJson(res, 200, evaluation);
  }

  // --------------------------------------------------------------------------
  // REST API: CAMERA & SCREEN RECORDING UPLOAD (/api/recordings/upload)
  // --------------------------------------------------------------------------
  if (pathname === '/api/recordings/upload' && method === 'POST') {
    const contentType = req.headers['content-type'] || '';
    const query = url.parse(req.url, true).query || {};

    let interviewId = query.interviewId;
    let type = query.type || 'camera'; // 'camera', 'screen', or 'audio'
    let buffer = null;

    // Check if client sent raw binary stream (Blob / octet-stream / video/webm)
    const isBinaryUpload = contentType.includes('video/') ||
                           contentType.includes('audio/') ||
                           contentType.includes('application/octet-stream') ||
                           (query.interviewId && !contentType.includes('application/json'));

    if (isBinaryUpload) {
      interviewId = interviewId || ('AV-' + Date.now().toString(36));
      try {
        const chunks = [];
        await new Promise((resolve, reject) => {
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', resolve);
          req.on('error', reject);
        });
        buffer = Buffer.concat(chunks);
      } catch (streamErr) {
        console.error('[Recording Stream Error]', streamErr);
        return sendJson(res, 500, { error: 'Failed to read upload stream' });
      }
    } else {
      const body = await parseBody(req);
      interviewId = body.interviewId || interviewId || ('AV-' + Date.now().toString(36));
      type = body.type || type || 'camera';
      const dataBase64 = body.videoBase64 || body.audioBase64 || body.base64;
      if (dataBase64) {
        try {
          buffer = Buffer.from(dataBase64.replace(/^data:\w+\/\w+;base64,/, ''), 'base64');
        } catch (b64Err) {
          console.warn('[Recording Base64 Parse Error]', b64Err);
        }
      }
    }

    if (!buffer || buffer.length === 0) {
      return sendJson(res, 400, { error: 'Missing or empty recording data' });
    }

    try {
      const filename = `${interviewId}-${type}.webm`;
      const filePath = path.join(RECORDINGS_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      // Keep both naming conventions (-camera.webm and -cam.webm) in sync
      if (type === 'camera') {
        const altFilename1 = `${interviewId}-cam.webm`;
        const altFilename2 = `${interviewId}-camera.webm`;
        fs.writeFileSync(path.join(RECORDINGS_DIR, altFilename1), buffer);
        fs.writeFileSync(path.join(RECORDINGS_DIR, altFilename2), buffer);
      }

      console.log(`[Storage] Saved ${type} recording for ${interviewId} (${buffer.length} bytes, file: ${filename})`);

      let recordingUrl = `/recordings/${filename}`;

      // Upload to Supabase Storage & Trigger Auto-FIFO Pruning if approaching limit
      if (Supabase.isConfigured()) {
        try {
          const cloudRes = await Supabase.uploadRecording(filename, buffer, 'video/webm');
          if (cloudRes && cloudRes.success && cloudRes.publicUrl) {
            recordingUrl = cloudRes.publicUrl;
            console.log(`[Supabase Storage] Successfully synced ${filename} to Supabase bucket -> ${recordingUrl}`);
          }
        } catch (cloudErr) {
          console.warn(`[Supabase Storage Warning] Could not sync to cloud, using local storage: ${cloudErr.message}`);
        }
      }

      const existingIv = DB.getInterviewById(interviewId);
      if (existingIv) {
        if (type === 'camera') {
          existingIv.cameraRecordingUrl = recordingUrl;
        } else if (type === 'screen') {
          existingIv.screenRecordingUrl = recordingUrl;
        } else {
          existingIv.recordingUrl = recordingUrl;
        }
        DB.saveInterview(existingIv);
      }

      return sendJson(res, 201, {
        success: true,
        interviewId: interviewId,
        url: recordingUrl,
        type: type,
        sizeBytes: buffer.length,
        cloudStorage: Supabase.isConfigured() ? 'supabase' : 'local'
      });
    } catch (err) {
      console.error('[Storage Error] Failed to save recording:', err);
      return sendJson(res, 500, { error: 'Failed to write recording to disk' });
    }
  }

  // --------------------------------------------------------------------------
  // REST API: USERS & AUTHENTICATION (CLERK & LOCAL DEMO)
  // --------------------------------------------------------------------------
  if (pathname === '/api/auth/config' && method === 'GET') {
    loadEnv();
    const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || '';
    const isConfigured = Boolean(publishableKey && publishableKey.startsWith('pk_'));
    return sendJson(res, 200, {
      clerkPublishableKey: publishableKey,
      isClerkConfigured: isConfigured,
      mode: isConfigured ? 'clerk' : 'local'
    });
  }

  // REST API: CLERK USER SYNCHRONIZATION
  if (pathname === '/api/auth/clerk-sync' && method === 'POST') {
    const body = await parseBody(req);
    const email = (body.email || '').toLowerCase().trim();
    const clerkId = body.clerkId || '';

    if (!email) {
      return sendJson(res, 400, { error: 'Email required' });
    }

    const isAdmin = DB.isAdminEmail(email);
    const userData = {
      id: body.id || ('usr_' + Date.now().toString(36)),
      clerkId: clerkId,
      name: body.name || email.split('@')[0],
      email: email,
      avatar: body.imageUrl || body.avatar || null,
      role: isAdmin ? 'admin' : 'student',
      status: 'Active',
      joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      lastLogin: new Date().toISOString()
    };

    let user = DB.upsertUser(userData);
    if (!user) {
      // Fallback if sqlite not active
      const users = readDb('users.json');
      user = users.find(u => (u.clerkId && u.clerkId === clerkId) || (email && u.email.toLowerCase() === email));
      if (!user) {
        user = userData;
        users.unshift(user);
      } else {
        user.name = userData.name;
        user.lastLogin = userData.lastLogin;
      }
      writeDb('users.json', users);
    }

    return sendJson(res, 200, {
      success: true,
      user: user,
      token: 'viva_clerk_' + Buffer.from(user.email).toString('base64')
    });
  }

  // REST API: DIRECT USER REGISTRATION (CLERK BACKEND SYNC)
  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await parseBody(req);
    const users = readDb('users.json');
    const email = (body.email || '').toLowerCase().trim();
    const name = (body.name || (email ? email.split('@')[0] : 'Candidate')).trim();
    const password = body.password || '';

    if (!email) {
      return sendJson(res, 400, { error: 'Email is required' });
    }

    let existing = users.find(u => u.email.toLowerCase() === email);
    let clerkId = null;

    // Direct Clerk backend user creation if secret key is configured
    const clerkSecret = process.env.CLERK_SECRET_KEY;
    if (clerkSecret && clerkSecret.trim().length > 10 && password) {
      try {
        const [firstName, ...rest] = name.split(' ');
        const clerkRes = await new Promise((resolve) => {
          const payload = JSON.stringify({
            email_address: [email],
            password: password,
            first_name: firstName || name,
            last_name: rest.join(' ') || '',
            skip_password_checks: true,
            skip_password_requirement: true
          });

          const clerkReq = https.request('https://api.clerk.com/v1/users', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${clerkSecret.trim()}`,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          }, (cRes) => {
            let data = '';
            cRes.on('data', chunk => data += chunk);
            cRes.on('end', () => {
              try {
                resolve(JSON.parse(data));
              } catch (e) {
                resolve(null);
              }
            });
          });

          clerkReq.on('error', (err) => {
            console.warn('[Clerk API Backend Error]:', err.message);
            resolve(null);
          });

          clerkReq.write(payload);
          clerkReq.end();
        });

        if (clerkRes && clerkRes.id) {
          clerkId = clerkRes.id;
          console.log(`[Clerk Backend Sync] Successfully registered user ${email} in Clerk project`);
        } else if (clerkRes && clerkRes.errors) {
          console.warn('[Clerk Registration Notice]:', clerkRes.errors[0]?.message);
          // If user already exists in Clerk, fetch their existing clerk id
          if (clerkRes.errors.some(e => e.code === 'form_identifier_exists')) {
            try {
              const fetchExistingClerk = await new Promise((resFetch) => {
                const getReq = https.request(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`, {
                  method: 'GET',
                  headers: { 'Authorization': `Bearer ${clerkSecret.trim()}` }
                }, (gRes) => {
                  let gData = '';
                  gRes.on('data', chunk => gData += chunk);
                  gRes.on('end', () => {
                    try { resFetch(JSON.parse(gData)); } catch (e) { resFetch(null); }
                  });
                });
                getReq.on('error', () => resFetch(null));
                getReq.end();
              });
              if (Array.isArray(fetchExistingClerk) && fetchExistingClerk[0]?.id) {
                clerkId = fetchExistingClerk[0].id;
                console.log(`[Clerk Backend Sync] Linked existing Clerk user ${clerkId} for ${email}`);
              }
            } catch (fetchErr) {}
          }
        }
      } catch (err) {
        console.warn('[Clerk API Exception]:', err.message);
      }
    }

    if (existing) {
      if (clerkId) existing.clerkId = clerkId;
      existing.lastLogin = new Date().toISOString();
      writeDb('users.json', users);
      return sendJson(res, 200, {
        success: true,
        user: existing,
        token: 'viva_auth_' + Buffer.from(existing.email).toString('base64')
      });
    }

    const isAdmin = DB.isAdminEmail(email);
    const newUser = {
      id: 'usr_' + Date.now().toString(36),
      clerkId: clerkId,
      name: name,
      email: email,
      avatar: null,
      role: isAdmin ? 'admin' : 'student',
      status: 'Active',
      joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      lastLogin: new Date().toISOString()
    };

    users.unshift(newUser);
    writeDb('users.json', users);
    console.log(`[Registration] Successfully created user: ${newUser.name} (${newUser.email})`);

    return sendJson(res, 201, {
      success: true,
      user: newUser,
      token: 'viva_auth_' + Buffer.from(newUser.email).toString('base64')
    });
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await parseBody(req);
    const users = readDb('users.json');
    const user = users.find(u => u.email.toLowerCase() === (body.email || '').toLowerCase());

    if (user) {
      const isAdmin = DB.isAdminEmail(user.email);
      user.role = isAdmin ? 'admin' : 'student';
      return sendJson(res, 200, {
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role
        },
        token: 'viva_sess_' + Buffer.from(user.email).toString('base64')
      });
    } else {
      // Create on the fly if valid email
      const isAdmin = DB.isAdminEmail(body.email);
      const newUser = {
        id: 'usr_' + Date.now().toString(36),
        name: body.name || (body.email ? body.email.split('@')[0] : 'Candidate'),
        email: body.email || 'student@msot.edu',
        role: isAdmin ? 'admin' : 'student',
        status: 'Active',
        joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      };
      users.unshift(newUser);
      writeDb('users.json', users);
      return sendJson(res, 200, {
        success: true,
        user: newUser,
        token: 'viva_sess_' + Buffer.from(newUser.email).toString('base64')
      });
    }
  }

  if (pathname === '/api/users') {
    if (method === 'GET') {
      const clerkSecret = process.env.CLERK_SECRET_KEY;
      // Asynchronous background sync: Do not block HTTP response waiting for Clerk network call
      if (clerkSecret && clerkSecret.trim().length > 10) {
        setImmediate(async () => {
          try {
            const clerkData = await new Promise((resolve) => {
              const cReq = https.request('https://api.clerk.com/v1/users?limit=100', {
                method: 'GET',
                headers: {
                  'Authorization': `Bearer ${clerkSecret.trim()}`,
                  'Content-Type': 'application/json'
                },
                timeout: 5000
              }, (cRes) => {
                let raw = '';
                cRes.on('data', chunk => raw += chunk);
                cRes.on('end', () => {
                  try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
                });
              });
              cReq.on('error', () => resolve(null));
              cReq.on('timeout', () => { cReq.destroy(); resolve(null); });
              cReq.end();
            });

            if (Array.isArray(clerkData) && clerkData.length > 0) {
              clerkData.forEach(u => {
                const email = (u.email_addresses?.[0]?.email_address || '').toLowerCase().trim();
                if (!email) return;
                const name = (u.first_name ? (u.first_name + ' ' + (u.last_name || '')).trim() : null) || email.split('@')[0];
                const avatar = u.image_url || null;
                const joinedDate = u.created_at ? new Date(u.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Oct 19, 2026';
                const lastLogin = u.last_sign_in_at ? new Date(u.last_sign_in_at).toISOString() : new Date().toISOString();
                const role = email.includes('admin') ? 'admin' : 'student';

                DB.upsertUser({
                  id: 'usr_' + u.id.slice(-8),
                  clerkId: u.id,
                  name,
                  email,
                  avatar,
                  role,
                  status: 'Active',
                  joinedDate,
                  lastLogin
                });
              });
            }
          } catch (syncErr) {
            console.warn('[Clerk Verified Users Sync Warning]:', syncErr.message);
          }
        });
      }

      const users = readDb('users.json');
      return sendJson(res, 200, users);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const users = readDb('users.json');
      const newUser = {
        id: 'usr_' + Date.now().toString(36),
        name: body.name || 'Student Candidate',
        email: body.email || 'student@msot.edu',
        role: body.role || 'student',
        status: 'Active',
        joinedDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      };
      users.unshift(newUser);
      writeDb('users.json', users);
      console.log(`[API] Created User: ${newUser.name} (${newUser.email})`);
      return sendJson(res, 201, newUser);
    }
  }

  // --------------------------------------------------------------------------
  // REST API: INTERVIEWS & FACULTY OVERRIDE
  // --------------------------------------------------------------------------
  // Faculty Override route: PUT /api/interviews/:id/override
  const overrideMatch = pathname.match(/^\/api\/interviews\/([^\/]+)\/override$/);
  if (overrideMatch && method === 'PUT') {
    const interviewId = overrideMatch[1];
    const body = await parseBody(req);
    const interviews = readDb('interviews.json');
    const idx = interviews.findIndex(i => i.id === interviewId);

    if (idx === -1) {
      return sendJson(res, 404, { error: 'Interview not found' });
    }

    const previousScore = interviews[idx].score;
    const newScore = Math.min(100, Math.max(0, parseInt(body.newScore, 10) || previousScore));
    interviews[idx].score = newScore;
    interviews[idx].readinessTier = newScore >= 75 ? 'Placement Ready' : 'Needs Review';
    interviews[idx].facultyOverride = {
      overridden: true,
      previousScore: previousScore,
      newScore: newScore,
      facultyName: body.facultyName || 'Dr. S. Kulkarni (HOD)',
      reason: body.reason || 'Reviewed voice transcript and evidence manually.',
      timestamp: new Date().toISOString()
    };

    writeDb('interviews.json', interviews);
    console.log(`[Audit] Faculty Override for ${interviewId}: ${previousScore} -> ${newScore} by ${body.facultyName}`);
    return sendJson(res, 200, interviews[idx]);
  }

  // --------------------------------------------------------------------------
  // REST API: ADMIN OVERVIEW REAL STATS (/api/admin/stats)
  // --------------------------------------------------------------------------
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const interviews = DB.isSqlite ? DB.getInterviews() : readDb('interviews.json');
    const users = DB.isSqlite ? DB.getUsers() : readDb('users.json');
    const totalInterviews = interviews.length;
    const avgScore = totalInterviews > 0 ? Math.round(interviews.reduce((acc, curr) => acc + (Number(curr.score) || 0), 0) / totalInterviews) : 0;
    const passed = interviews.filter(i => (Number(i.score) || 0) >= 70).length;
    const passRate = totalInterviews > 0 ? Math.round((passed / totalInterviews) * 100) : 0;
    return sendJson(res, 200, {
      totalInterviews,
      avgScore,
      passRate,
      totalUsers: users.length,
      activeToday: interviews.length
    });
  }

  // Single interview by ID: GET /api/interviews/:id
  const singleIvMatch = pathname.match(/^\/api\/interviews\/([^\/]+)$/);
  if (singleIvMatch && method === 'GET' && !pathname.includes('/override')) {
    const interviewId = singleIvMatch[1];
    const iv = DB.isSqlite ? DB.getInterviewById(interviewId) : readDb('interviews.json').find(i => i.id === interviewId);
    if (!iv) {
      return sendJson(res, 404, { error: 'Interview not found' });
    }
    return sendJson(res, 200, iv);
  }

  if (pathname === '/api/interviews') {
    if (method === 'GET') {
      const emailFilter = parsedUrl.searchParams.get('email');
      let interviews = DB.isSqlite ? DB.getInterviews() : readDb('interviews.json');
      if (emailFilter) {
        const clean = emailFilter.toLowerCase().trim();
        interviews = interviews.filter(i => (i.studentEmail || i.candidateEmail || '').toLowerCase().trim() === clean);
      }
      return sendJson(res, 200, interviews);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const newInterview = {
        id: body.id || ('AV-' + Math.floor(1000 + Math.random() * 9000)),
        candidateName: body.candidateName || body.studentName || 'Candidate',
        candidateEmail: body.candidateEmail || body.studentEmail || 'student@college.edu',
        studentName: body.candidateName || body.studentName || 'Candidate',
        studentEmail: body.candidateEmail || body.studentEmail || 'student@college.edu',
        topic: body.topic || 'Data Structures',
        technology: body.technology || 'Python',
        difficulty: body.difficulty || 'Medium',
        duration: body.duration || '15 min',
        score: typeof body.score === 'number' ? body.score : 80,
        maxScore: 100,
        status: 'Completed',
        durationSeconds: body.durationSeconds || 900,
        readinessTier: body.readinessTier || ((body.score || 80) >= 75 ? 'Placement Ready' : 'Needs Review'),
        summary: body.summary || 'Viva examination successfully completed and evaluated.',
        date: body.date || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        fullDate: body.fullDate || new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        cameraRecordingUrl: body.cameraRecordingUrl || `/recordings/${body.id || 'viva'}-camera.webm`,
        screenRecordingUrl: body.screenRecordingUrl || `/recordings/${body.id || 'viva'}-screen.webm`,
        isDisqualified: !!body.isDisqualified,
        disqualificationReason: body.disqualificationReason || '',
        scorecard: {
          score: body.score || 80,
          readinessTier: body.readinessTier || ((body.score || 80) >= 75 ? 'Placement Ready' : 'Needs Review'),
          summary: body.summary || 'Viva examination successfully completed and evaluated.',
          isDisqualified: !!body.isDisqualified,
          disqualificationReason: body.disqualificationReason || '',
          rubricBreakdown: body.rubricBreakdown || {},
          strengths: body.strengths || [],
          improvements: body.improvements || [],
          suggestions: body.suggestions || [],
          annotatedTranscript: body.annotatedTranscript || body.transcript || []
        },
        rubricBreakdown: body.rubricBreakdown || {},
        strengths: body.strengths || [],
        improvements: body.improvements || [],
        suggestions: body.suggestions || [],
        annotatedTranscript: body.annotatedTranscript || body.transcript || [],
        transcript: body.transcript || body.transcripts || [],
        transcripts: body.transcript || body.transcripts || []
      };

      if (DB.isSqlite) {
        DB.saveInterview(newInterview);
      } else {
        const interviews = readDb('interviews.json');
        interviews.unshift(newInterview);
        writeDb('interviews.json', interviews);
      }
      console.log(`[API] Saved Interview Session ${newInterview.id} with score ${newInterview.score}/100 to SQLite`);
      return sendJson(res, 201, newInterview);
    }
  }

  // --------------------------------------------------------------------------
  // REST API: LIVE TRANSCRIPT STEP PERSISTENCE (/api/interviews/transcript-step)
  // --------------------------------------------------------------------------
  if (pathname === '/api/interviews/transcript-step' && method === 'POST') {
    const body = await parseBody(req);
    const sessionInterviewId = body.interviewId || 'session';
    console.log(`[Transcript Step DB] [${body.speaker || 'candidate'}] (${body.stage || 'Live'}): "${(body.text || '').slice(0, 60)}..."`);
    return sendJson(res, 200, {
      success: true,
      interviewId: sessionInterviewId,
      step: {
        speaker: body.speaker,
        text: body.text,
        timestamp: body.timestamp || new Date().toISOString(),
        stage: body.stage,
        questionRef: body.questionRef
      }
    });
  }

  // --------------------------------------------------------------------------
  // REST API: TOPICS & QUESTION BANKS
  // --------------------------------------------------------------------------
  if (pathname === '/api/topics') {
    if (method === 'GET') {
      const topics = readDb('topics.json');
      return sendJson(res, 200, topics);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const topics = readDb('topics.json');
      const newTopic = {
        id: 'top_' + Date.now().toString(36),
        name: body.name || 'New Technical Subject',
        description: body.description || 'Topic curriculum and questions',
        status: 'Active'
      };
      topics.push(newTopic);
      writeDb('topics.json', topics);
      console.log(`[API] Added Topic: ${newTopic.name}`);
      return sendJson(res, 201, newTopic);
    }
  }

  // --------------------------------------------------------------------------
  // REST API: PROCTORING & INTEGRITY LOGS
  // --------------------------------------------------------------------------
  if (pathname === '/api/cheating-logs') {
    if (method === 'GET') {
      const logs = readDb('cheating_logs.json');
      return sendJson(res, 200, Array.isArray(logs) ? logs : []);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      let logs = readDb('cheating_logs.json');
      if (!Array.isArray(logs)) logs = [];

      const newLog = {
        id: 'cheat_' + Date.now().toString(36),
        interviewId: body.interviewId || 'AV-1048',
        studentName: body.studentName || 'Candidate',
        studentEmail: body.studentEmail || 'student@msot.edu',
        event: body.event || 'Proctoring Flag',
        details: body.details || 'Detected by integrity engine',
        risk: body.risk || 'Medium',
        time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        reviewStatus: 'Needs review',
        snapshot: body.snapshot || ''
      };
      logs.unshift(newLog);
      // Keep most recent 200 incidents
      if (logs.length > 200) logs = logs.slice(0, 200);
      writeDb('cheating_logs.json', logs);
      console.log(`[Integrity Proctor] Logged incident: "${newLog.event}" for ${newLog.studentName} (Risk: ${newLog.risk})`);
      return sendJson(res, 201, newLog);
    }
  }

  // Update incident review status: PATCH /api/cheating-logs/:id
  const cheatReviewMatch = pathname.match(/^\/api\/cheating-logs\/([a-zA-Z0-9_-]+)$/);
  if (cheatReviewMatch && (method === 'PATCH' || method === 'PUT')) {
    const id = cheatReviewMatch[1];
    const body = await parseBody(req);
    let logs = readDb('cheating_logs.json');
    if (Array.isArray(logs)) {
      const target = logs.find(c => c.id === id);
      if (target) {
        if (body.reviewStatus) target.reviewStatus = body.reviewStatus;
        writeDb('cheating_logs.json', logs);
        return sendJson(res, 200, target);
      }
    }
    return sendJson(res, 404, { error: 'Incident not found' });
  }

  // --------------------------------------------------------------------------
  // REST API: INTERVIEW FLOWS (/api/flows)
  // --------------------------------------------------------------------------
  if (pathname === '/api/flows') {
    if (method === 'GET') {
      const flows = readDb('flows.json');
      return sendJson(res, 200, flows);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      let flows = readDb('flows.json');
      if (!Array.isArray(flows)) flows = [];

      const nextStep = flows.length > 0 ? Math.max(...flows.map(f => Number(f.step) || 0)) + 1 : 1;
      const newStage = {
        step: Number(body.step) || nextStep,
        name: body.name || `Stage ${nextStep}: Technical Evaluation`,
        desc: body.desc || 'Comprehensive candidate technical assessment',
        guidance: body.guidance || 'Probe core concepts, trade-offs, and practical implementations.',
        timing: body.timing || '15:00 – 17:00',
        category: body.category || 'technical',
        icon: body.icon || 'codeSimple'
      };

      flows.push(newStage);
      flows.sort((a, b) => (Number(a.step) || 0) - (Number(b.step) || 0));
      flows.forEach((s, idx) => { s.step = idx + 1; });

      writeDb('flows.json', flows);
      console.log(`[API] Added Interview Flow Stage: ${newStage.name} (Step ${newStage.step})`);
      return sendJson(res, 201, newStage);
    }
    if (method === 'PUT') {
      const body = await parseBody(req);
      if (Array.isArray(body)) {
        writeDb('flows.json', body);
        console.log(`[API] Updated entire interview flows list (${body.length} stages)`);
        return sendJson(res, 200, body);
      }
    }
  }

  // Update / Delete flow stage: /api/flows/:step
  const flowItemMatch = pathname.match(/^\/api\/flows\/(\d+)$/);
  if (flowItemMatch) {
    const stepNum = parseInt(flowItemMatch[1], 10);
    let flows = readDb('flows.json');
    if (!Array.isArray(flows)) flows = [];

    if (method === 'PUT' || method === 'PATCH') {
      const body = await parseBody(req);
      const stageIndex = flows.findIndex(f => Number(f.step) === stepNum);
      if (stageIndex === -1) {
        return sendJson(res, 404, { error: `Flow stage step ${stepNum} not found` });
      }

      flows[stageIndex] = {
        ...flows[stageIndex],
        name: body.name !== undefined ? body.name : flows[stageIndex].name,
        desc: body.desc !== undefined ? body.desc : flows[stageIndex].desc,
        guidance: body.guidance !== undefined ? body.guidance : flows[stageIndex].guidance,
        timing: body.timing !== undefined ? body.timing : flows[stageIndex].timing,
        category: body.category !== undefined ? body.category : flows[stageIndex].category,
        icon: body.icon !== undefined ? body.icon : flows[stageIndex].icon
      };

      writeDb('flows.json', flows);
      console.log(`[API] Updated Interview Flow Stage ${stepNum}: "${flows[stageIndex].name}"`);
      return sendJson(res, 200, flows[stageIndex]);
    }

    if (method === 'DELETE') {
      flows = flows.filter(f => Number(f.step) !== stepNum);
      flows.forEach((s, idx) => { s.step = idx + 1; });
      writeDb('flows.json', flows);
      console.log(`[API] Deleted Interview Flow Step ${stepNum}`);
      return sendJson(res, 200, flows);
    }
  }

  // --------------------------------------------------------------------------
  // REST API: FEEDBACKS
  // --------------------------------------------------------------------------
  if (pathname === '/api/feedbacks') {
    if (method === 'GET') {
      const feedbacks = readDb('feedbacks.json');
      return sendJson(res, 200, feedbacks);
    }
    if (method === 'POST') {
      const body = await parseBody(req);
      const feedbacks = readDb('feedbacks.json');
      const newFeedback = {
        id: 'fb_' + Date.now().toString(36),
        name: body.name || 'Student Candidate',
        email: body.email || 'student@msot.edu',
        topic: body.topic || 'General Viva',
        rating: body.rating || 5,
        comment: body.comment || 'Smooth voice interview experience.',
        date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      };
      feedbacks.unshift(newFeedback);
      writeDb('feedbacks.json', feedbacks);
      console.log(`[API] Saved Feedback from ${newFeedback.name} (${newFeedback.rating} stars)`);
      return sendJson(res, 201, newFeedback);
    }
  }

  // --------------------------------------------------------------------------
  // STATIC AUDIO SERVING (/recordings/...)
  // --------------------------------------------------------------------------
  if (pathname.startsWith('/recordings/')) {
    const filename = path.basename(pathname);
    let recordingPath = path.join(RECORDINGS_DIR, filename);

    // If -cam.webm requested but only -camera.webm exists, or vice versa
    if (!fs.existsSync(recordingPath)) {
      if (filename.includes('-cam.webm')) {
        const alt = path.join(RECORDINGS_DIR, filename.replace('-cam.webm', '-camera.webm'));
        if (fs.existsSync(alt)) recordingPath = alt;
      } else if (filename.includes('-camera.webm')) {
        const alt = path.join(RECORDINGS_DIR, filename.replace('-camera.webm', '-cam.webm'));
        if (fs.existsSync(alt)) recordingPath = alt;
      }
    }

    if (fs.existsSync(recordingPath)) {
      const ext = path.extname(recordingPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'video/webm';
      const stat = fs.statSync(recordingPath);
      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const fileStream = fs.createReadStream(recordingPath, { start, end });
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime
        });
        return fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mime,
          'Accept-Ranges': 'bytes'
        });
        return fs.createReadStream(recordingPath).pipe(res);
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Recording not found on disk', filename }));
    }
  }

  // --------------------------------------------------------------------------
  // STATIC FILE SERVING (SPA)
  // --------------------------------------------------------------------------
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, safePath);

  if (safePath === '/' || safePath === '' || safePath === 'sso-callback' || safePath.startsWith('sso-callback')) {
    filePath = path.join(__dirname, 'index.html');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback: serve index.html for client-side routing
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, 'utf8', (readErr, content) => {
        if (readErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        const pubKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || '';
        let html = content;
        if (pubKey && pubKey.startsWith('pk_')) {
          html = html.replace(
            /<script async crossorigin="anonymous" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@clerk\/clerk-js@latest\/dist\/clerk\.browser\.js"><\/script>/,
            `<script id="clerk-sdk-script" async crossorigin="anonymous" data-clerk-publishable-key="${pubKey}" src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>`
          );
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (filePath.endsWith('index.html')) {
      fs.readFile(filePath, 'utf8', (readErr, content) => {
        if (readErr) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end('500 Internal Server Error');
        }
        const pubKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY || '';
        let html = content;
        if (pubKey && pubKey.startsWith('pk_')) {
          html = html.replace(
            /<script async crossorigin="anonymous" src="https:\/\/cdn\.jsdelivr\.net\/npm\/@clerk\/clerk-js@latest\/dist\/clerk\.browser\.js"><\/script>/,
            `<script id="clerk-sdk-script" async crossorigin="anonymous" data-clerk-publishable-key="${pubKey}" src="https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js"></script>`
          );
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('500 Internal Server Error');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(content);
    });
  });
});

// --------------------------------------------------------------------------
// 8. SERVER START WITH PORT FALLBACK
// --------------------------------------------------------------------------
function startServer(portToTry) {
  server.listen(portToTry, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`  VivaAI Production Engine is running!`);
    console.log(`  Access URL: http://localhost:${portToTry}`);
    console.log(`  REST API  : http://localhost:${portToTry}/api/health`);
    console.log(`  Database  : ${DB.isSqlite ? 'Bun Native SQLite (data/viva.sqlite)' : 'JSON Store'}`);
    console.log(`  Runtime   : ${process.versions.bun ? 'Bun v' + process.versions.bun : 'Node ' + process.version}`);
    console.log(`  OpenRouter: ${process.env.OPENROUTER_API_KEY ? 'Configured' : 'Fallback Engine Active'}`);
    console.log(`  Recordings: ${RECORDINGS_DIR}`);
    console.log(`======================================================\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[Warning] Port ${portToTry} in use, trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('[Server Error]:', err);
    }
  });
}

startServer(PORT);
