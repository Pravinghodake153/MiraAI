# VivaAI — Platform Architecture, Concurrency & Cost Analysis

This document provides a comprehensive technical breakdown of the **VivaAI Technical Examination Platform**, designed to conduct 15-minute technical viva examinations for **350 students** in a single event, with a capacity of **100–150 concurrent sessions**.

---

## 1. System Architecture

```
                                  [ STUDENT BROWSER ]
                   ┌───────────────────────┴───────────────────────┐
                   │                                               │
             (Video & Mic)                                   (Web Speech API)
                   ▼                                               ▼
     [ Local Media Stream ]                               [ Browser-Native STT ]
     • 720p Front Camera Preview                         • Zero Network Latency
     • Web Audio Level Visualizer                        • Zero External API Cost
     • Client-side MediaRecorder                         • Real-time Spoken Turns
                   │                                               │
                   └───────────────────────┬───────────────────────┘
                                           │
                         (JSON REST API over HTTP/WebSocket)
                                           │
                                           ▼
                                [ VIVAAI BACKEND NODE.JS ]
                                • Server-Authoritative 15-Min Timer
                                • Session State & Integrity Guard
                                • Audio Recording Chunk Uploader
                                           │
              ┌────────────────────────────┴────────────────────────────┐
              ▼                                                         ▼
    [ OPENROUTER AI GATEWAY ]                                [ RELATIONAL / FILE DB ]
    • Model: openai/gpt-4o-mini                             • `data/users.json`
    • Live Viva Questioning (<1.5s latency)                 • `data/interviews.json`
    • 5-Dimension Rubric Evaluation                         • `data/cheating_logs.json`
    • Temperature: 0 (Deterministic Scoring)                • `data/recordings/*.webm`
              │                                                         │
              └────────────────────────────┬────────────────────────────┘
                                           │
                                           ▼
                                [ FACULTY ADMIN PORTAL ]
                                • Real-time Session Monitoring
                                • Proctoring Flag Human Review
                                • Timestamped Audio/Transcript Audit
                                • Official Faculty Grade Override
```

---

## 2. Complete Student Journey

1. **Landing Page (`/home`)**: Student reviews exam syllabus and viva instructions.
2. **Account Sign-up / Login (`/login`)**: Authenticates student by institutional roll number and college email.
3. **Recording & Proctoring Consent (`/consent`)**: Explains video/audio capture, 180-day retention policy, authorized reviewer scope, and proctoring signal rules. Requires explicit candidate consent.
4. **Device & Environment Hardware Check (`/device-check`)**: Verifies microphone level meter, camera feed, speaker test chime, and network latency (<30ms).
5. **Live Voice Viva Arena (`/interview`)**:
   - Conducted by AI interviewer **Mira**.
   - 7-Stage progression: Warm-up (0-1m) &rarr; Fundamentals (1-5m) &rarr; Depth (5-10m) &rarr; Applied Problem (10-13m) &rarr; Review &rarr; Wrap-up (13-14.5m) &rarr; Complete (14.5-15m).
   - Strict UI rule: **Only Mira's active spoken question is displayed**. No past transcripts are shown during the viva.
   - Server-authoritative timer automatically terminates session at exactly 15:00.
6. **Post-Viva Evaluation Pipeline (`/evaluation`)**: Shows animated 3-step progress while the server evaluates answers against the 5-part rubric and persists results.
7. **Scorecard & Detailed Report (`/scorecard`)**: Displays mark out of 100, readiness tier, dimensional breakdown, strengths, improvements, and the complete evidence-linked transcript.

---

## 3. Cost Analysis for 350 Students

### Pricing Assumptions:
- **Examination Duration**: 15 minutes per student.
- **Total Students**: 350 students.
- **Total Examination Time**: 350 &times; 15 min = 5,250 minutes (87.5 hours).
- **LLM Model**: `openai/gpt-4o-mini` via OpenRouter.
  - Input pricing: $0.150 per 1,000,000 tokens ($0.00000015/token).
  - Output pricing: $0.600 per 1,000,000 tokens ($0.0000006/token).
- **Speech-to-Text (STT)**: Browser-native Web Speech API &rarr; **$0.00**.
- **Text-to-Speech (TTS)**: Browser-native SpeechSynthesis &rarr; **$0.00**.
- **Audio Storage**: Compressed Opus WebM audio (~16 kbps) &approx; 1.8 MB per 15-minute viva &rarr; 630 MB for all 350 students.

### Per-Interview Cost Breakdown:

| Service / Resource | Usage Per Student | Cost Per Student | Total Cost (350 Students) |
| :--- | :--- | :--- | :--- |
| **Speech-to-Text (STT)** | 15 mins audio (Browser Web Speech) | **$0.00** | **$0.00** |
| **Text-to-Speech (TTS)** | 15 mins speech (Browser Synthesis) | **$0.00** | **$0.00** |
| **Mira Live Interviewer (LLM)** | ~6 questions &rarr; 3,500 input / 400 output tokens | $0.00076 | **$0.27** |
| **Post-Interview Rubric Scoring (LLM)** | 1 eval call &rarr; 2,800 input / 750 output tokens | $0.00087 | **$0.31** |
| **Audio Storage (180 days)** | ~1.8 MB / student on Object Storage ($0.02/GB/mo) | $0.00021 | **$0.07** |
| **Backend Compute & Egress** | Node.js Server on standard instance | $0.00500 | **$1.75** |
| **Total Cost** | **Per 15-Minute Viva** | **$0.0068** | **$2.40 Total** |

> **Conclusion**: The entire 350-student viva examination event costs **under $3.00 USD total** when utilizing OpenRouter with browser-native real-time voice streaming.

---

## 4. Concurrency & Scaling Strategy (100–150 Concurrent Sessions)

To conduct 350 examinations within a standard 1-hour window:
- **Batch 1 (00:00 - 00:20)**: 120 concurrent students.
- **Batch 2 (00:20 - 00:40)**: 120 concurrent students.
- **Batch 3 (00:40 - 01:00)**: 110 concurrent students.

### Architecture Protections:
1. **Isolated Session Workers**: Each student session holds state independently. A failure in one student's connection never affects any other student.
2. **Server-Authoritative Timing**: The 15-minute timer is calculated from `startTime` on the backend, making it immune to student client refreshes or tampering.
3. **Graceful Degraded Fallback**: If OpenRouter encounters external internet throttling, the system seamlessly uses the local technical question bank and deterministic rubric calculator with zero interruption to active examinees.
4. **Asynchronous Background Scoring**: Post-interview evaluation runs in an asynchronous job queue after session termination so that live questioning latency is never impacted.

---

## 5. Academic Integrity & Human Faculty Review

- **Signal Only, Not Automated Penalty**: An integrity alert (e.g. tab switch or multi-speaker detection) is flagged for **human instructor review**. Students are **never automatically failed** by the AI.
- **Faculty Score Override**: Instructors can review the student's timestamped transcript, listen to recording playback, and enter an official score override with recorded technical justification.
