import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom Metrics
const droppedSessions = new Counter('dropped_sessions');
const llmErrorRate = new Rate('llm_error_rate');
const transcriptionLatency = new Trend('transcription_latency');
const questionLatency = new Trend('question_generation_latency');
const videoUploadLatency = new Trend('video_upload_latency');

// Multi-stage Ramp: 50 -> 100 -> 150 concurrent simulated students
export const options = {
  stages: [
    { duration: '15s', target: 50 },  // Level 1: 50 concurrent students
    { duration: '30s', target: 50 },
    { duration: '15s', target: 100 }, // Level 2: 100 concurrent students
    { duration: '30s', target: 100 },
    { duration: '15s', target: 150 }, // Level 3: 150 concurrent students
    { duration: '45s', target: 150 },
    { duration: '15s', target: 0 }    // Cool-down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<3500'], // p95 response time target
    'llm_error_rate': ['rate<0.05'],     // error rate under 5%
    'dropped_sessions': ['count<5']
  }
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:8080';

// Realistic synthetic audio & candidate answers across viva topics
const CANDIDATE_PROFILES = [
  { name: 'Aarav Patel', topic: 'Data Structures', answer: 'Arrays provide O(1) random indexing through contiguous memory addresses, while linked lists require pointer traversal in O(n).' },
  { name: 'Priya Sharma', topic: 'Operating Systems', answer: 'A process possesses its own independent address space and file descriptors, whereas threads within the same process share heap memory and code segments.' },
  { name: 'Rohan Deshmukh', topic: 'Database Management', answer: 'ACID guarantees atomicity, consistency, isolation, and durability. B+ Trees are preferred in databases because broad fanout minimizes disk seek latency.' },
  { name: 'Ananya Iyer', topic: 'Computer Networks', answer: 'TCP provides reliable, ordered stream delivery via 3-way handshakes and sliding window flow control, while UDP prioritizes low latency without retransmission.' },
  { name: 'Vikram Malhotra', topic: 'Algorithms', answer: 'Quicksort partitions the array around a pivot with average O(n log n) performance, whereas Mergesort guarantees O(n log n) worst-case using O(n) auxiliary memory.' }
];

export default function () {
  const profile = CANDIDATE_PROFILES[__VU % CANDIDATE_PROFILES.length];
  const interviewId = `LOAD-VU-${__VU}-${Date.now().toString(36)}`;

  // 1. Health check & Initial Ping
  const pingRes = http.get(`${BASE_URL}/api/health`);
  const isHealthy = check(pingRes, {
    'health check status is 200': (r) => r.status === 200
  });

  if (!isHealthy) {
    droppedSessions.add(1);
    sleep(1);
    return;
  }

  // 2. Candidate Speech Transcription Step (Simulating Live STT / Transcript Ingestion)
  const transcriptPayload = JSON.stringify({
    interviewId: interviewId,
    speaker: 'student',
    text: profile.answer,
    stage: 'Fundamentals',
    timestamp: '02:15'
  });

  const tStart = Date.now();
  const transcriptRes = http.post(`${BASE_URL}/api/interviews/transcript-step`, transcriptPayload, {
    headers: { 'Content-Type': 'application/json' }
  });
  transcriptionLatency.add(Date.now() - tStart);

  check(transcriptRes, {
    'transcript logged status is 200': (r) => r.status === 200
  });

  // 3. AI Viva Question Generation (LLM Live Turn)
  const chatPayload = JSON.stringify({
    topic: profile.topic,
    stage: 'Fundamentals',
    currentStage: {
      name: 'Fundamentals',
      timing: '1:00 – 5:00',
      guidance: 'Probe memory allocation and time complexity trade-offs.'
    },
    questionHistory: [
      { speaker: 'mira', text: 'Explain the fundamental differences between primary data structures.' },
      { speaker: 'student', text: profile.answer }
    ],
    lastStudentAnswer: profile.answer,
    currentTime: '02:30',
    remainingTime: '12:30'
  });

  const qStart = Date.now();
  const chatRes = http.post(`${BASE_URL}/api/ai/chat`, chatPayload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s'
  });
  const qLatency = Date.now() - qStart;
  questionLatency.add(qLatency);

  const questionOk = check(chatRes, {
    'AI question status 200': (r) => r.status === 200,
    'AI question has content': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b && b.question && b.question.length > 5;
      } catch (e) {
        return false;
      }
    }
  });

  if (!questionOk) {
    llmErrorRate.add(1);
  } else {
    llmErrorRate.add(0);
  }

  // 4. Proctoring Event Log (Simulating Tab-switch / Face tracking telemetry)
  if (__ITER % 3 === 0) {
    const proctorPayload = JSON.stringify({
      interviewId: interviewId,
      studentName: profile.name,
      eventName: 'Tab switch detected',
      severity: 'medium',
      details: 'Candidate switched tabs for 1.2s'
    });
    http.post(`${BASE_URL}/api/cheating-logs`, proctorPayload, {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 5. Video Recording Stream Chunks Upload (Simulating MediaRecorder chunk flush)
  if (__ITER % 5 === 0) {
    const fakeChunk = 'RIFF....WEBM-MOCK-BINARY-CHUNK-FOR-LOAD-TESTING-STUDENT-STREAM';
    const uStart = Date.now();
    const uploadRes = http.post(
      `${BASE_URL}/api/recordings/upload?interviewId=${interviewId}&type=camera`,
      fakeChunk,
      {
        headers: { 'Content-Type': 'video/webm' },
        timeout: '15s'
      }
    );
    videoUploadLatency.add(Date.now() - uStart);
    check(uploadRes, {
      'video chunk upload 200 or 201': (r) => r.status === 200 || r.status === 201
    });
  }

  // Natural student cadence between interview turns (1s - 3s)
  sleep(1.5);
}
