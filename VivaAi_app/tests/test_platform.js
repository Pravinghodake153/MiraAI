// ==============================================================================
// VivaAI Platform Automated Test Suite & Concurrency Benchmark
// Tests: Auth, Live Viva Chat, Rubric Evaluation, Proctoring, Faculty Override,
// and 150-Concurrent Session Throughput Benchmark.
// ==============================================================================

const http = require('http');

const BASE_URL = process.env.TEST_URL || `http://localhost:${process.env.PORT || '8080'}`;

function request(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const bodyStr = data ? JSON.stringify(data) : '';

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : {} });
        } catch (e) {
          resolve({ status: res.statusCode, body: body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(bodyStr);
    req.end();
  });
}

async function runTestSuite() {
  console.log('\n======================================================');
  console.log('  VivaAI System Validation & Concurrency Test Suite');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`• [TEST] ${name} ... `);
    try {
      await fn();
      console.log('PASSED');
      passed++;
    } catch (err) {
      console.log('FAILED');
      console.error('  Error:', err.message);
      failed++;
    }
  }

  // 1. Health & Environment Check
  await test('Server Health Check & Config', async () => {
    const res = await request('/api/health');
    if (res.status !== 200 || res.body.status !== 'ok') {
      throw new Error(`Expected status 200 ok, got ${res.status}`);
    }
    if (res.body.activeDurationMinutes !== 15) {
      throw new Error('Default duration should be 15 minutes');
    }
  });

  // 2. Authentication & User Creation
  let testUserId = null;
  await test('User Creation & Auth Login', async () => {
    const res = await request('/api/auth/login', 'POST', {
      name: 'Test Student',
      email: 'test.student@msot.edu'
    });
    if (res.status !== 200 || !res.body.token) {
      throw new Error('Login failed or did not return session token');
    }
    testUserId = res.body.user.id;
  });

  // 3. Mira Question Generation
  await test('Live Question Generation (/api/ai/chat)', async () => {
    const res = await request('/api/ai/chat', 'POST', {
      topic: 'Data Structures',
      stage: 'Fundamentals',
      questionHistory: [],
      lastStudentAnswer: 'I have worked with arrays and linked lists.'
    });
    if (res.status !== 200 || !res.body.question) {
      throw new Error('Did not return viva question');
    }
    if (res.body.question.length < 10) {
      throw new Error('Question too short');
    }
  });

  // 4. Automated Rubric Evaluation (5 dimensions)
  let testInterviewId = null;
  await test('Automated Post-Interview Rubric Scoring (/api/ai/evaluate)', async () => {
    const sampleTranscript = [
      { speaker: 'mira', text: 'Explain how binary search operates on an array.' },
      { speaker: 'student', text: 'Binary search requires a sorted array. It divides the search space in half by comparing with the midpoint element, achieving logarithmic time complexity O(log n).' },
      { speaker: 'mira', text: 'What happens when elements are unsorted?' },
      { speaker: 'student', text: 'If unsorted, binary search fails because monotonicity is lost. We must sort in O(n log n) or use linear search O(n).' }
    ];

    const res = await request('/api/ai/evaluate', 'POST', {
      studentName: 'Test Student',
      topic: 'Data Structures',
      transcript: sampleTranscript,
      durationSeconds: 900
    });

    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const score = res.body.score;
    if (typeof score !== 'number' || score < 0 || score > 100) {
      throw new Error(`Score out of range: ${score}`);
    }

    const rub = res.body.rubricBreakdown;
    if (!rub.conceptual || !rub.depth || !rub.problemSolving || !rub.practical || !rub.communication) {
      throw new Error('Missing one of the 5 mandatory rubric dimensions');
    }

    // Save session
    const saveRes = await request('/api/interviews', 'POST', {
      candidateName: 'Test Student',
      topic: 'Data Structures',
      score: score,
      rubricBreakdown: rub,
      transcript: sampleTranscript
    });
    testInterviewId = saveRes.body.id;
  });

  // 5. Proctoring Integrity Event Logging
  await test('Integrity Event Logging (/api/cheating-logs)', async () => {
    const res = await request('/api/cheating-logs', 'POST', {
      interviewId: testInterviewId || 'AV-1048',
      studentName: 'Test Student',
      studentEmail: 'test.student@msot.edu',
      event: 'Tab switch detected',
      details: 'Navigated away from examination window for 4 seconds',
      risk: 'Medium'
    });
    if (res.status !== 201 || !res.body.id) {
      throw new Error('Failed to record integrity flag');
    }

    // Test Mobile Phone Detected Flag
    const phoneRes = await request('/api/cheating-logs', 'POST', {
      interviewId: testInterviewId || 'AV-1048',
      studentName: 'Test Student',
      studentEmail: 'test.student@msot.edu',
      event: 'Mobile phone detected',
      details: 'A mobile phone or unauthorized electronic device was detected in your camera frame (92% confidence).',
      risk: 'High',
      snapshot: 'data:image/jpeg;base64,samplephoneshot'
    });
    if (phoneRes.status !== 201 || phoneRes.body.event !== 'Mobile phone detected') {
      throw new Error('Failed to record Mobile phone detected integrity event');
    }

    // Test Screenshot / Screen Capture Attempt Flag (Cmd+Shift+3/4/5)
    const screenRes = await request('/api/cheating-logs', 'POST', {
      interviewId: testInterviewId || 'AV-1048',
      studentName: 'Test Student',
      studentEmail: 'test.student@msot.edu',
      event: 'Screen capture attempt',
      details: 'Unauthorized screenshot shortcut (Cmd+Shift+4) detected. Screen recording and screenshot capture during the viva is strictly prohibited.',
      risk: 'High',
      snapshot: 'data:image/jpeg;base64,samplescreenshot'
    });
    if (screenRes.status !== 201 || screenRes.body.event !== 'Screen capture attempt') {
      throw new Error('Failed to record Screen capture attempt integrity event');
    }
  });

  // 6. Faculty Score Override
  await test('Faculty Grade Override Audit Trail', async () => {
    if (!testInterviewId) testInterviewId = 'AV-1048';
    const res = await request(`/api/interviews/${testInterviewId}/override`, 'PUT', {
      newScore: 88,
      facultyName: 'Dr. S. Kulkarni (HOD)',
      reason: 'Reviewed audio recording; candidate provided precise nuance on monotonicity.'
    });
    if (res.status !== 200 || res.body.score !== 88) {
      throw new Error(`Override failed or score mismatch: ${res.body.score}`);
    }
    if (!res.body.facultyOverride || !res.body.facultyOverride.overridden) {
      throw new Error('Faculty override audit log missing');
    }
  });

  // 7. High Concurrency Throughput Test (Simulating 150 Simultaneous Requests)
  await test('150 Concurrent Live Requests Load Benchmark', async () => {
    const CONCURRENT_COUNT = 150;
    const startTime = Date.now();

    const requests = Array.from({ length: CONCURRENT_COUNT }, (_, i) => {
      return request('/api/ai/chat', 'POST', {
        topic: i % 2 === 0 ? 'Data Structures' : 'Operating Systems',
        stage: 'Fundamentals',
        questionHistory: [],
        lastStudentAnswer: `Answer from student #${i + 1}`
      });
    });

    const results = await Promise.all(requests);
    const durationMs = Date.now() - startTime;
    const all200 = results.every(r => r.status === 200);

    if (!all200) {
      const failedCount = results.filter(r => r.status !== 200).length;
      throw new Error(`${failedCount} out of ${CONCURRENT_COUNT} concurrent requests failed`);
    }

    console.log(`\n    -> Handled ${CONCURRENT_COUNT} simultaneous requests in ${durationMs}ms (${(CONCURRENT_COUNT / (durationMs / 1000)).toFixed(1)} req/sec)`);
  });

  console.log('\n------------------------------------------------------');
  console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runTestSuite().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
