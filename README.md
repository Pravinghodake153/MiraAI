# MiraAI - Autonomous AI Technical Viva Examination Platform

[![Platform: Node.js & Bun](https://img.shields.io/badge/Runtime-Node%20%7C%20Bun-blue.svg)](https://nodejs.org)
[![Status: Production Ready](https://img.shields.io/badge/Status-Production%20Ready-green.svg)](https://render.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

MiraAI is an autonomous technical viva examination system built for higher education institutions (MSOT). It conducts realistic, timed oral viva examinations, monitors real-time proctoring (camera, mobile phone detection, tab switches, shortcut interceptions), generates structured transcripts, and evaluates candidates across 5 weighted dimensions according to strict academic rubrics.

---

## 🌟 Key Features

1. **Autonomous Conversational Viva Engine**:
   - Sequential progression through admin-configured stages (Warm-up &rarr; Fundamentals &rarr; Depth &rarr; Applied Problem &rarr; Wrap-up).
   - Strict 20–30 word conversational questions without robotic preamble.
   - Built-in corruption auto-repair and 2nd fallback retry if AI generation fails.

2. **Deterministic 5-Dimension Rubric Scoring**:
   - Conceptual Understanding: **30%**
   - Depth & Reasoning: **25%**
   - Problem Solving: **20%**
   - Practical / Project Knowledge: **15%**
   - Communication: **10%**
   - System calculates overall grade deterministically. AI cannot manipulate or override the weighted aggregate score.

3. **Multi-Modal AI Proctoring & Integrity Audits**:
   - Local on-device computer vision detects cell phone usage, face absence, and multiple faces without streaming raw frames to external servers.
   - Hotkey interceptions (`Cmd+Shift+3/4/5`, `PrintScreen`) and blur/tab-switching detection with timestamped cheating logs.

4. **Dual Synchronized Video Recordings**:
   - Simultaneous client-side MediaRecorder capture for Webcam and Screen.
   - Resilient chunk upload to backend with playback preview and faculty audit archive.

5. **Unified Single-Process Architecture (Zero-CORS)**:
   - Frontend and backend are served together from a single port/domain.
   - Works seamlessly with both **Node.js** (Render, Heroku, standard Linux) and **Bun** (local high-speed SQLite).

---

## 🚀 Quick Start (Local Development)

### 1. Clone the repository
```bash
git clone https://github.com/Pravinghodake153/MiraAI.git
cd MiraAI
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` inside `VivaAi_app`:
```bash
cp VivaAi_app/.env.example VivaAi_app/.env
```
Add your free [OpenRouter API Key](https://openrouter.ai/keys) to `VivaAi_app/.env`:
```env
PORT=8080
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
```

### 3. Run the Platform
```bash
# Using Node.js:
npm start

# Or using Bun:
bun run VivaAi_app/server.js
```
Open **`http://localhost:8080`** in Google Chrome or Microsoft Edge.

---

## ☁️ 100% Free Deployment on Render

Deploying MiraAI to **[Render.com](https://render.com)** takes 2 minutes and costs $0:

1. **Sign in** to [dashboard.render.com](https://dashboard.render.com) using your GitHub account.
2. Click **New +** &rarr; **Web Service**.
3. Select your repository: **`Pravinghodake153/MiraAI`**.
4. Configure the service settings:
   - **Name**: `mira-ai` (or any name you choose)
   - **Region**: Oregon (US West) or Singapore
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install` (or leave blank)
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Click **Advanced** &rarr; **Add Environment Variable**:
   | Variable | Value | Description |
   |---|---|---|
   | `OPENROUTER_API_KEY` | `sk-or-v1-...` | Your OpenRouter API key |
   | `OPENROUTER_MODEL` | `google/gemini-2.5-flash-lite` | High-speed low-cost AI model |
   | `NODE_ENV` | `production` | Production mode |
6. Click **Create Web Service**.

Render will deploy your application and provide a free secure URL: `https://mira-ai.onrender.com`.

---

## 📁 Repository Structure

```
├── README.md               # Project documentation & deployment guide
├── package.json            # Root process runner (npm start)
├── run.sh                  # Local development bash launcher
├── UI-wiring/              # UI mockups, diagrams, and reference wireframes
└── VivaAi_app/             # Core application directory
    ├── index.html          # High-performance SPA frontend
    ├── server.js           # Single-file production HTTP & REST API server
    ├── db.js               # Multi-engine SQLite & JSON data access layer
    ├── css/
    │   └── style.css       # Unified design system & responsive UI styles
    ├── js/
    │   ├── api.js          # REST API client bridge
    │   ├── app.js          # Main SPA controller, audio pipeline & state
    │   ├── icons.js        # SVG icon library (zero external icon deps)
    │   └── vendor/         # Bundled offline AI proctoring models (BlazeFace, COCO-SSD)
    └── data/
        ├── admins.json     # Role-based admin access control
        ├── flows.json      # Structured viva stage definitions
        ├── topics.json     # Technical topics & competency question banks
        └── recordings/     # Examination video storage directory
```

---

## 🧪 Automated Test Suite

Run the full platform verification suite:
```bash
node VivaAi_app/tests/test_platform.js
```
Verifies:
- Server Health & REST API connectivity
- Candidate Authentication
- Dynamic AI Viva Question generation (with anti-corruption retries)
- Strict 5-dimension rubric weight calculations
- Anti-cheating telemetry ingestion
- Faculty grade override workflows
- Concurrency load (150 parallel requests)
