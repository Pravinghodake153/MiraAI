# VivaAI - 100% Free Production Deployment Guide

This guide explains how to deploy **VivaAI** online for **100% FREE** with **zero bugs, zero CORS issues, and automatic HTTPS/SSL**.

---

## 1. Architecture Overview (How It Works)

VivaAI is designed as an **All-in-One Single-Service Architecture**:

```
+-------------------------------------------------------------+
|                YOUR APP DOMAIN (e.g. Render)                |
|                                                             |
|   Frontend UI (HTML/CSS/JS)   <--->   Backend REST API      |
|   (SPA served from root /)            (/api/ai, /api/auth)  |
|                                                |            |
|                                                v            |
|                                       Embedded SQLite DB    |
|                                       & JSON Storage        |
|                                       (data/viva.sqlite)    |
+-------------------------------------------------------------+
                               |
                               v
                     OpenRouter AI API
               (Free Model: openrouter/free)
```

### Why There Are No Connection / CORS Bugs:
Unlike projects that host frontend on Vercel and backend on AWS (which causes CORS bugs and cookie errors), VivaAI runs the **Frontend, Backend API, and Database together in one single container**.
- The frontend talks to `/api` directly using relative paths (`/api/...`).
- No complicated CORS headers or domain mismatches.
- Everything works straight out of the box.

---

## 2. Recommended Free Hosting Platform: Render.com

**Why Render?**
- **100% Free Forever Tier** (750 free hours every month).
- Automatic **Free SSL Certificate** (`https://`).
- Connects directly to your **GitHub repository** with 1 click.
- Automatic deploys whenever you push new changes to GitHub.
- Zero server setup or Linux management needed.

---

## 3. Step-by-Step Deployment Instructions

### Step 1: Push Your Project to GitHub
1. Create a free account on [GitHub.com](https://github.com) if you haven't already.
2. Create a new GitHub repository called `viva-ai` (set it to Public or Private).
3. In your local terminal, push your project to GitHub:
   ```bash
   cd /path/to/VivaAi_app
   git init
   git add .
   git commit -m "Initial VivaAI release"
   git branch -M main
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/viva-ai.git
   git push -u origin main
   ```

---

### Step 2: Create a Free Service on Render
1. Go to [Render.com](https://render.com) and click **Sign Up** (sign in using your GitHub account).
2. On your dashboard, click **"New +"** and choose **"Web Service"**.
3. Select your `viva-ai` repository from the list and click **Connect**.

---

### Step 3: Configure Service Settings (Copy Exactly)

Fill in the settings as shown below:

| Field | Value |
| :--- | :--- |
| **Name** | `viva-ai` (or any name you like) |
| **Region** | Singapore, Frankfurt, or Ohio (pick closest to you) |
| **Branch** | `main` |
| **Root Directory** | Leave blank (or `VivaAi_app` if your repo has parent folder) |
| **Runtime** | **Node** |
| **Build Command** | `echo "Ready"` (No npm build needed! Zero dependencies!) |
| **Start Command** | `node server.js` |
| **Instance Type** | **Free** ($0 / month) |

---

### Step 4: Add Environment Variables

Scroll down to **"Environment Variables"** and click **"Add Environment Variable"**:

| Key | Value | Description |
| :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | `sk-or-v1-...` | Your free OpenRouter API key |
| `OPENROUTER_MODEL` | `openrouter/free` | Uses 100% free high-performance AI models |
| `PORT` | `10000` | Port automatically assigned by Render |
| `NODE_ENV` | `production` | Runs server in production mode |

---

### Step 5: Click Deploy!
1. Click the blue **"Create Web Service"** button.
2. Render will build and launch your application in less than 60 seconds!
3. You will get a free live URL: `https://viva-ai-xxxx.onrender.com`.

---

## 4. How the Database & Recordings Work for Free

1. **Embedded Database (`data/viva.sqlite`)**:
   - The app uses embedded SQLite and JSON storage. All interview histories, student accounts, cheating logs, and rubric scores are saved directly on the service.
2. **Video & Screen Recordings (`data/recordings/`)**:
   - Camera and screen recordings are saved as `.webm` files directly in `data/recordings/`.
   - On Render's free tier, the filesystem resets if the server restarts after inactivity.
   - **For Permanent Cloud Video Storage (Optional & Free)**:
     If you need video recordings preserved permanently across years, you can connect **Cloudinary** or **Supabase Storage** (both offer free 10–25 GB cloud buckets).

---

## 5. Alternative 100% Free Hosts

If you want alternatives to Render:

1. **Koyeb.com**:
   - Free Eco Nano service (always on, never sleeps).
   - Start command: `node server.js`.
2. **Railway.app**:
   - $5 monthly free trial credit.
   - Extremely fast startup.
3. **Hugging Face Spaces (Docker)**:
   - 100% free forever, 2 vCPUs, 16GB RAM, persistent disk.
   - No credit card required.

---

## 6. Verification Checklist

After deploying, verify these 4 items:
- [ ] Open your live URL: `https://your-app.onrender.com`.
- [ ] Check API Health: Open `https://your-app.onrender.com/api/health` -> should say `{"status":"ok"}`.
- [ ] Run a 1-minute test viva: verify Professor Mira speaks and transcribes audio.
- [ ] Check Scorecard: verify the 5-part weighted score is calculated.
