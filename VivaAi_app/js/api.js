// ==========================================================================
// VivaAI Frontend API Client
// Connects UI actions to Localhost Backend REST API & OpenRouter Engine
// ==========================================================================

const API = {
  baseUrl: (window.location.origin && window.location.origin.startsWith('http'))
    ? window.location.origin
    : '',

  async request(endpoint, method = 'GET', data = null) {
    try {
      const url = `${this.baseUrl}/api${endpoint}`;
      const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
      };
      if (data && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(data);
      }
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (err) {
      console.warn(`[API] Server request to ${endpoint} failed, falling back to local simulation:`, err);
      return null;
    }
  },

  // 1. Auth & Users
  async login(email, name) {
    const res = await this.request('/auth/login', 'POST', { email, name });
    return res || { success: true, user: { name: name || 'Student', email: email, role: 'student' } };
  },

  async loginUser(email, password) {
    const res = await this.request('/auth/login', 'POST', { email, password });
    return res || { success: true, user: { name: email.split('@')[0], email: email, role: 'student' } };
  },

  async registerUser(userData) {
    const res = await this.request('/auth/register', 'POST', userData);
    return res || { success: true, user: { name: userData.name || 'Student', email: userData.email, role: 'student' } };
  },

  async getUsers() {
    const res = await this.request('/users');
    return res || [];
  },

  async createUser(userData) {
    const res = await this.request('/users', 'POST', userData);
    return res || { id: 'usr_local', ...userData, joinedDate: 'Just now' };
  },

  // 2. AI Live Question Generation (Mira)
  async generateAiQuestion(payload) {
    const res = await this.request('/ai/chat', 'POST', payload);
    return res || {
      question: "Could you explain the memory layout difference between an array and a linked list?",
      provider: "Local Offline Engine",
      stage: payload.stage || "Fundamentals"
    };
  },

  // 3. Post-Interview Rubric Scoring (Evaluator)
  async evaluateViva(payload) {
    const res = await this.request('/ai/evaluate', 'POST', payload);
    return res;
  },

  // 4. AI Configuration (OpenRouter Key & Model)
  async getAiConfig() {
    const res = await this.request('/ai/config');
    return res || { configured: false, model: 'openai/gpt-4o-mini' };
  },

  async updateAiConfig(data) {
    return await this.request('/ai/config', 'POST', data);
  },

  // 5. Video & Media Recording Storage
  async uploadRecording(interviewId, data, type = 'camera') {
    // If data is a Blob or File, upload directly as binary stream
    if (data && typeof data === 'object' && (data instanceof Blob || data.size !== undefined)) {
      try {
        const url = `${this.baseUrl}/api/recordings/upload?interviewId=${encodeURIComponent(interviewId)}&type=${encodeURIComponent(type)}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': data.type || 'video/webm'
          },
          body: data
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (err) {
        console.warn(`[API] Binary upload failed for ${type}:`, err);
        return null;
      }
    }

    // Fallback if data is a base64 string
    return await this.request('/recordings/upload', 'POST', {
      interviewId,
      videoBase64: data,
      type
    });
  },

  // 6. Interviews & Faculty Override
  async getInterviews(email = null) {
    const endpoint = email ? `/interviews?email=${encodeURIComponent(email)}` : '/interviews';
    const res = await this.request(endpoint);
    return res || [];
  },

  async getInterviewById(id) {
    const res = await this.request(`/interviews/${id}`);
    return res;
  },

  async getAdminStats() {
    const res = await this.request('/admin/stats');
    return res;
  },

  async saveInterview(interviewData) {
    const res = await this.request('/interviews', 'POST', interviewData);
    return res || { id: 'AV-local', ...interviewData };
  },

  async overrideScore(interviewId, overrideData) {
    const res = await this.request(`/interviews/${interviewId}/override`, 'PUT', overrideData);
    return res;
  },

  // 7. Topics
  async getTopics() {
    const res = await this.request('/topics');
    return res || [];
  },

  async createTopic(topicData) {
    const res = await this.request('/topics', 'POST', topicData);
    return res || { id: 'top_local', ...topicData };
  },

  // 7b. Interview Flow Stages
  async getFlows() {
    const res = await this.request('/flows');
    return res || [];
  },

  async createFlowStage(stageData) {
    const res = await this.request('/flows', 'POST', stageData);
    return res || stageData;
  },

  async updateFlowStage(stepNum, stageData) {
    const res = await this.request(`/flows/${stepNum}`, 'PUT', stageData);
    return res || stageData;
  },

  async deleteFlowStage(stepNum) {
    const res = await this.request(`/flows/${stepNum}`, 'DELETE');
    return res || [];
  },

  // 8. Cheating & Proctoring Integrity Logs
  async getCheatingLogs() {
    const res = await this.request('/cheating-logs');
    return res || [];
  },

  async logCheatingEvent(eventData) {
    const res = await this.request('/cheating-logs', 'POST', eventData);
    return res || { id: 'cheat_local', ...eventData };
  },

  async updateCheatingReviewStatus(id, reviewStatus) {
    const res = await this.request(`/cheating-logs/${id}`, 'PATCH', { reviewStatus });
    return res;
  },

  // 9. Feedbacks
  async getFeedbacks() {
    const res = await this.request('/feedbacks');
    return res || [];
  },

  async submitFeedback(feedbackData) {
    const res = await this.request('/feedbacks', 'POST', feedbackData);
    return res || { id: 'fb_local', ...feedbackData };
  },

  // 10. Voice Engine Settings & AI Models
  async getSettings() {
    const res = await this.request('/settings');
    return res || {
      voiceEngineMode: 'web',
      llmModel: 'openrouter/free',
      ttsModel: 'fish-audio/s2.1-pro-free:free',
      sttModel: 'openai/whisper-large-v3-turbo',
      openRouterConfigured: false
    };
  },

  async updateSettings(settingsData) {
    const res = await this.request('/settings', 'POST', settingsData);
    return res;
  },

  // 11. TTS & STT Online Fallback endpoints
  async synthesizeSpeech(text) {
    const res = await this.request('/ai/tts', 'POST', { text });
    return res;
  },

  async transcribeSpeech(audioBase64) {
    const res = await this.request('/ai/stt', 'POST', { audioBase64 });
    return res;
  },

  // 12. Arranged Live Transcript Step Persistence
  async logTranscriptStep(stepData) {
    const res = await this.request('/interviews/transcript-step', 'POST', stepData);
    return res;
  },

  // 13. Clerk Authentication Integration
  async getAuthConfig() {
    const res = await this.request('/auth/config');
    return res || { clerkPublishableKey: '', isClerkConfigured: false, mode: 'local' };
  },

  async syncClerkUser(userData) {
    const res = await this.request('/auth/clerk-sync', 'POST', userData);
    return res;
  },

  // 14. Admin Whitelist & Access Control Management
  async getAdminWhitelist() {
    const res = await this.request('/admin/whitelist');
    return res?.admins || [];
  },

  async addAdminEmail(email, addedBy) {
    const res = await this.request('/admin/whitelist', 'POST', { email, addedBy });
    return res;
  },

  async removeAdminEmail(email) {
    const res = await this.request('/admin/whitelist', 'DELETE', { email });
    return res;
  },

  async checkAdminStatus(email) {
    const res = await this.request(`/admin/check?email=${encodeURIComponent(email)}`);
    return res?.isAdmin || false;
  }
};

// Wire browser visibility detection (Automatic Tab-switch logging to backend)
document.addEventListener('visibilitychange', () => {
  if (document.hidden && window.location.hash.includes('/interview')) {
    console.warn('[Integrity Monitor] Tab switch detected! Saving to backend...');
    API.logCheatingEvent({
      interviewId: window.currentInterviewId || 'AV-1048',
      studentName: (window.currentUser && window.currentUser.name) || 'Pravin Ghodake',
      studentEmail: (window.currentUser && window.currentUser.email) || 'student@msot.edu',
      event: 'Tab switch detected',
      details: 'Candidate navigated away from viva screen',
      risk: 'Medium'
    });
  }
});

window.API = API;
