// ============================================================================
// VivaAI Supabase Client & Auto-Pruning Storage Engine
// Project Ref: vveubzrxvlklepzthuvq
// All-in-One Cloud DB + Storage + Auto FIFO Cleanup when storage gets full
// ============================================================================

const https = require('https');
const url = require('url');

function getSupabaseUrl() {
  return (process.env.SUPABASE_URL || `https://${process.env.SUPABASE_PROJECT_REF || 'vveubzrxvlklepzthuvq'}.supabase.co`).replace(/\/$/, '');
}

function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || '';
}

// Free tier storage buffer threshold: 900 MB limit (Supabase free tier provides 1GB)
// When total bucket usage exceeds MAX_STORAGE_BYTES, oldest recordings are automatically deleted
const MAX_STORAGE_BYTES = parseInt(process.env.SUPABASE_MAX_STORAGE_BYTES || (900 * 1024 * 1024), 10);
const RECORDINGS_BUCKET = process.env.SUPABASE_RECORDINGS_BUCKET || 'recordings';

// Check if credentials are configured
function isConfigured() {
  return Boolean(getSupabaseUrl() && getSupabaseKey());
}

// ----------------------------------------------------------------------------
// Low-level HTTPS helper for zero-dependency Supabase REST & Storage API
// ----------------------------------------------------------------------------
function supabaseRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('Supabase credentials (SUPABASE_KEY) not configured'));
    }

    const baseUrl = getSupabaseUrl();
    const key = getSupabaseKey();
    const fullUrl = `${baseUrl}${endpoint}`;
    const parsed = new URL(fullUrl);

    const headers = {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      ...(options.headers || {})
    };

    const reqOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.path,
      method: options.method || 'GET',
      headers: headers
    };

    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        let parsedData = null;
        try {
          parsedData = JSON.parse(bodyStr);
        } catch (_) {
          parsedData = bodyStr;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: parsedData, headers: res.headers });
        } else {
          const errMsg = typeof parsedData === 'object' && parsedData?.message ? parsedData.message : bodyStr;
          reject(new Error(`Supabase API ${options.method || 'GET'} ${endpoint} failed (${res.statusCode}): ${errMsg}`));
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (options.body) {
      if (Buffer.isBuffer(options.body)) {
        req.write(options.body);
      } else if (typeof options.body === 'object') {
        req.write(JSON.stringify(options.body));
      } else {
        req.write(String(options.body));
      }
    }
    req.end();
  });
}

// ----------------------------------------------------------------------------
// Supabase Storage Bucket Initialization
// ----------------------------------------------------------------------------
async function ensureRecordingsBucket() {
  if (!isConfigured()) return false;
  try {
    const listRes = await supabaseRequest('/storage/v1/bucket');
    const buckets = Array.isArray(listRes.data) ? listRes.data : [];
    const exists = buckets.some(b => b.name === RECORDINGS_BUCKET || b.id === RECORDINGS_BUCKET);
    if (!exists) {
      await supabaseRequest('/storage/v1/bucket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          id: RECORDINGS_BUCKET,
          name: RECORDINGS_BUCKET,
          public: true,
          file_size_limit: 104857600
        }
      });
      console.log(`[Supabase Storage] Created public bucket "${RECORDINGS_BUCKET}" successfully.`);
    }
    return true;
  } catch (err) {
    console.warn(`[Supabase Storage] Bucket ensure check: ${err.message}`);
    return false;
  }
}

// ----------------------------------------------------------------------------
// List all files in the recordings bucket with size & metadata
// ----------------------------------------------------------------------------
async function listAllRecordings() {
  if (!isConfigured()) return [];
  try {
    const res = await supabaseRequest(`/storage/v1/object/list/${RECORDINGS_BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        prefix: '',
        limit: 1000,
        offset: 0,
        sortBy: { column: 'created_at', order: 'asc' } // Oldest files first (FIFO)
      }
    });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.warn('[Supabase Storage] List recordings error:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// Delete files from Supabase Storage
// ----------------------------------------------------------------------------
async function deleteFiles(fileNames) {
  if (!isConfigured() || !Array.isArray(fileNames) || fileNames.length === 0) return false;
  try {
    await supabaseRequest(`/storage/v1/object/${RECORDINGS_BUCKET}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: { prefixes: fileNames }
    });
    console.log(`[Supabase Storage Auto-Prune] Deleted ${fileNames.length} old recording(s):`, fileNames);
    return true;
  } catch (err) {
    console.warn('[Supabase Storage] Delete error:', err.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// AUTO FIFO CLEANUP: When storage is full or nearing max capacity,
// automatically deletes the oldest recordings to free up required space.
// ----------------------------------------------------------------------------
async function ensureStorageCapacity(incomingSizeBytes = 0) {
  if (!isConfigured()) return { pruned: 0, freedBytes: 0 };

  try {
    const files = await listAllRecordings();
    let totalBytes = files.reduce((acc, f) => {
      const size = f.metadata?.size || f.size || 0;
      return acc + size;
    }, 0);

    const projectedUsage = totalBytes + incomingSizeBytes;
    console.log(`[Supabase Storage Monitor] Current: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB / Max: ${(MAX_STORAGE_BYTES / (1024 * 1024)).toFixed(2)} MB`);

    if (projectedUsage <= MAX_STORAGE_BYTES) {
      return { pruned: 0, freedBytes: 0, totalBytes };
    }

    console.warn(`[Supabase Storage Auto-Prune Triggered] Projected usage ${(projectedUsage / (1024 * 1024)).toFixed(2)} MB exceeds limit! Deleting oldest recordings...`);

    const toDelete = [];
    let bytesFreed = 0;

    // Files are sorted created_at ASC (oldest first)
    for (const file of files) {
      toDelete.push(file.name);
      bytesFreed += (file.metadata?.size || file.size || 0);

      // Stop once we have freed enough buffer (at least 50MB extra breathing room)
      if ((totalBytes - bytesFreed + incomingSizeBytes) < (MAX_STORAGE_BYTES - 50 * 1024 * 1024)) {
        break;
      }
    }

    if (toDelete.length > 0) {
      await deleteFiles(toDelete);
      console.log(`[Supabase Storage Auto-Prune Done] Freed ${(bytesFreed / (1024 * 1024)).toFixed(2)} MB across ${toDelete.length} files.`);
      return { pruned: toDelete.length, freedBytes: bytesFreed, filesDeleted: toDelete };
    }

    return { pruned: 0, freedBytes: 0 };
  } catch (err) {
    console.error('[Supabase Storage Auto-Prune Error]', err.message);
    return { pruned: 0, freedBytes: 0, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Upload Recording File (buffer) to Supabase Storage with automatic pruning
// ----------------------------------------------------------------------------
async function uploadRecording(filename, buffer, contentType = 'video/webm') {
  if (!isConfigured()) {
    return { success: false, reason: 'unconfigured' };
  }

  // 1. Ensure bucket exists
  await ensureRecordingsBucket();

  // 2. Automatic check: If storage will exceed threshold, prune oldest recordings first
  await ensureStorageCapacity(buffer.length);

  // 3. Upload file directly to Supabase Storage
  try {
    const uploadPath = `/storage/v1/object/${RECORDINGS_BUCKET}/${encodeURIComponent(filename)}`;
    await supabaseRequest(uploadPath, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer
    });

    const publicUrl = `${getSupabaseUrl()}/storage/v1/object/public/${RECORDINGS_BUCKET}/${encodeURIComponent(filename)}`;
    console.log(`[Supabase Storage Uploaded] ${filename} (${buffer.length} bytes) -> ${publicUrl}`);

    return {
      success: true,
      filename: filename,
      publicUrl: publicUrl,
      sizeBytes: buffer.length
    };
  } catch (err) {
    console.error(`[Supabase Storage Upload Error] for ${filename}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ----------------------------------------------------------------------------
// Supabase Database Table Helpers (PostgreSQL REST Bridge)
// ----------------------------------------------------------------------------
async function dbSelect(table, query = '') {
  if (!isConfigured()) return null;
  try {
    const res = await supabaseRequest(`/rest/v1/${table}${query ? '?' + query : ''}`);
    return res.data;
  } catch (err) {
    console.warn(`[Supabase DB Select Warning] ${table}:`, err.message);
    return null;
  }
}

async function dbUpsert(table, data, onConflict = 'id') {
  if (!isConfigured()) return null;
  try {
    const res = await supabaseRequest(`/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: Array.isArray(data) ? data : [data]
    });
    return res.data;
  } catch (err) {
    console.warn(`[Supabase DB Upsert Warning] ${table}:`, err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  getSupabaseUrl,
  getSupabaseKey,
  RECORDINGS_BUCKET,
  MAX_STORAGE_BYTES,
  ensureRecordingsBucket,
  listAllRecordings,
  deleteFiles,
  ensureStorageCapacity,
  uploadRecording,
  dbSelect,
  dbUpsert
};
