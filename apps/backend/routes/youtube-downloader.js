const express = require('express');
const ytdl = require('@distube/ytdl-core');
const sanitize = require('sanitize-filename');
const cp = require('child_process');
const stream = require('stream');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

// Directory to store temporary files for resume functionality
const TEMP_DIR = path.join(__dirname, '../temp');

// Active downloads tracker
const activeDownloads = new Map();

// Ensure temp directory exists
const ensureTempDir = async () => {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create temp directory:', err);
  }
};

// Initialize temp directory
ensureTempDir();

// Global error handler to prevent crashes from unhandled stream errors
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.log('Suppressed pipe error (client disconnected)');
    return;
  }
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason?.code === 'EPIPE' || reason?.code === 'ECONNRESET') {
    console.log('Suppressed pipe rejection (client disconnected)');
    return;
  }
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down download manager...');
  DownloadManager.destroyCleanupTimers();
  // Cleanup all active downloads
  DownloadManager.instances.forEach((manager) => manager.cleanup());
  DownloadManager.instances.clear();
});

process.on('SIGINT', () => {
  console.log('Shutting down download manager...');
  DownloadManager.destroyCleanupTimers();
  DownloadManager.instances.forEach((manager) => manager.cleanup());
  DownloadManager.instances.clear();
  process.exit(0);
});

// Helper function to generate unique ID for download
const generateDownloadId = (url, type, quality) => {
  const hash = crypto.createHash('md5');
  hash.update(`${url}-${type}-${quality}`);
  return hash.digest('hex');
};

// Helper function to get temp file path
const getTempFilePath = (downloadId) => {
  return path.join(TEMP_DIR, `${downloadId}.tmp`);
};

// Helper function to get metadata file path
const getMetadataFilePath = (downloadId) => {
  return path.join(TEMP_DIR, `${downloadId}.meta.json`);
};

// Helper function to save download metadata
const saveDownloadMetadata = async (downloadId, metadata) => {
  try {
    const metaPath = getMetadataFilePath(downloadId);
    await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
  } catch (err) {
    console.error('Failed to save metadata:', err);
  }
};

// Helper function to load download metadata
const loadDownloadMetadata = async (downloadId) => {
  try {
    const metaPath = getMetadataFilePath(downloadId);
    const data = await fs.readFile(metaPath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
};

// Helper function to clean up temporary files
const cleanupTempFiles = async (downloadId) => {
  try {
    const tempPath = getTempFilePath(downloadId);
    const metaPath = getMetadataFilePath(downloadId);

    await Promise.allSettled([
      fs.unlink(tempPath).catch(() => {}),
      fs.unlink(metaPath).catch(() => {})
    ]);

    // Remove from active downloads
    // activeDownloads.delete(downloadId);
  } catch (err) {
    console.error('Cleanup error:', err);
  }
};

// Helper function to get file size
const getFileSize = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (err) {
    return 0;
  }
};

function cleanFilename(title) {
  return sanitize(title).replace(/[^\x00-\x7F]/g, ''); // remove non-ASCII
}

// Download manager class
class DownloadManager {
  static instances = new Map();
  static instanceCleanup = new Map();
  constructor(downloadId, metadata) {
    this.downloadId = downloadId;
    this.metadata = metadata;
    this.isPaused = false;
    this.isCompleted = false;
    this.isCancelled = false;
    this.currentSize = 0;
    this.streams = [];
    this.ffmpeg = null;
    this.tempFileStream = null;
    this.responseStream = null;

    DownloadManager.initializeCleanupTimers(this.downloadId);
  }

  static getInstance(downloadId, metadata) {
    if (this.instances.has(downloadId)) {
      console.log(`Reusing existing DownloadManager for ${downloadId}`);
      return this.instances.get(downloadId);
    }

    console.log(`Creating new DownloadManager for ${downloadId}`);
    const instance = new DownloadManager(downloadId, metadata);
    this.instances.set(downloadId, instance);
    return instance;
  }
  static initializeCleanupTimers(downloadId) {
    console.log(`Initializing cleanup timers for ${downloadId}`);
    if (!this.instanceCleanup.has(downloadId)) {
      this.instanceCleanup.set(downloadId ,setInterval(() => {
        this.cleanupOldInstances(downloadId);
      }, 24 * 60 * 60 * 1000)); // 24 hours
    }
    console.log('Download cleanup timers initialized for', downloadId);
  }

  static async destroyCleanupTimers() {
    for (const [downloadId, manager] of this.instances.entries()) {
      clearInterval(this.instanceCleanup.get(downloadId));
    }
    this.instanceCleanup = new WeakMap();
    console.log('Download cleanup timers destroyed');
  }

  async pause() {
    if (this.isPaused || this.isCompleted) return;

    console.log(`Pausing download ${this.downloadId}`);
    this.isPaused = true;
    // Update metadata
    this.metadata.status = 'paused';
    this.metadata.lastModified = new Date().toISOString();
    this.metadata.currentSize = this.currentSize;
    await saveDownloadMetadata(this.downloadId, this.metadata);

    // Clean up streams and processes
    await this.cleanup();
  }

  async resume() {
    if (!this.isPaused || this.isCompleted) return;

    console.log(`Resuming download ${this.downloadId}`);
    this.isPaused = false;

    // Update metadata
    this.metadata.status = 'in progress';
    this.metadata.lastModified = new Date().toISOString();
    await saveDownloadMetadata(this.downloadId, this.metadata);
  }

  async cancel() {
    console.log(`Cancelling download ${this.downloadId}`);
    this.isCancelled = true;
    await this.cleanup();
  }
  async complete() {
    console.log(`Download ${this.downloadId} completed`);
    this.isCompleted = true;
    this.metadata.status = 'completed';
    this.metadata.lastModified = new Date().toISOString();
    await this.cleanup();
  }

  async cleanup() {
    if (!(await DownloadManager.cleanup(this.downloadId))) {
      console.log(`Cleanup attempted for non-existent download: ${this.downloadId}`);
      return;
    }
    // Close all streams
    console.log('Cleaning up streams...');
    this.streams.forEach((stream) => {
      // console.log('Stream:', stream);
      if (stream && !stream.destroyed) {
        console.log('Closing stream...');
        try {
          stream.destroy();
        } catch (e) {
          // Ignore errors
          console.log('Error closing stream:', e);
        }
      }
    });

    console.log('Cleaning up temp file stream...');
    // Close temp file stream
    if (this.tempFileStream && !this.tempFileStream.destroyed) {
      console.log('Closing temp file stream...');
      try {
        this.tempFileStream.end();
      } catch (e) {
        // Ignore errors
        console.log('Error closing temp file stream:', e);
      }
    }
    console.log('Cleaning up ffmpeg process...');
    // Kill ffmpeg process
    if (this.ffmpeg && !this.ffmpeg.killed) {
      console.log('Killing ffmpeg process...');
      try {
        this.ffmpeg.kill('SIGTERM');
        setTimeout(() => {
          if (this.ffmpeg && !this.ffmpeg.killed) {
            this.ffmpeg.kill('SIGKILL');
          }
        }, 1000);
      } catch (e) {
        // Ignore errors
        console.log('Error killing ffmpeg process:', e);
      }
    }

    this.streams = [];
    this.tempFileStream = null;
    this.ffmpeg = null;
  }
  static async cleanup(downloadId) {
    if (!this.instances.has(downloadId)) {
      console.log(`Cleanup attempted for non-existent download: ${downloadId}`);
      return false;
    }
    this.instances.delete(downloadId);
    activeDownloads.delete(downloadId);
    return true;
  }

  static async cleanupOldInstances(downloadId) {
    const MAX_AGE = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const metadata = await loadDownloadMetadata(downloadId);
    if (now - new Date(metadata.createdAt).getTime() > MAX_AGE) {
      console.log(`Cleaning up old instance: ${downloadId}`);
      this.instances.delete(downloadId);
      activeDownloads.delete(downloadId);
      cleanupTempFiles(downloadId);
      clearInterval(this.instanceCleanup.get(downloadId));
      this.instanceCleanup.delete(downloadId);
    }
  }
}

// Route to check download status
router.get('/download/status/:downloadId', async (req, res) => {
  const { downloadId } = req.params;

  try {
    const metadata = await loadDownloadMetadata(downloadId);
    if (!metadata) {
      return res.status(404).json({ error: 'Download not found' });
    }

    const tempPath = getTempFilePath(downloadId);
    const currentSize = await getFileSize(tempPath);
    const downloadManager = activeDownloads.get(downloadId);

    const progress = metadata.totalSize ? Math.round((currentSize / metadata.totalSize) * 100) : 0;

    res.json({
      downloadId,
      progress,
      currentSize,
      totalSize: metadata.totalSize,
      filename: cleanFilename(metadata.filename),
      status: downloadManager
        ? downloadManager.isPaused
          ? 'paused'
          : metadata.status
        : metadata.status,
      createdAt: metadata.createdAt,
      isActive: !!downloadManager
    });
  } catch (err) {
    console.error('Status check error:', err);
    res.status(500).json({ error: 'Failed to check status' });
  }
});

// Route to pause download
router.post('/download/pause/:downloadId', async (req, res) => {
  const { downloadId } = req.params;
  const _activeDownloads = activeDownloads.get(downloadId);

  if (!_activeDownloads) {
    return res.status(404).json({ error: 'Active download not found' });
  }

  try {
    let metadata = await loadDownloadMetadata(downloadId);
    if (!metadata) {
      return res.status(404).json({ error: 'Download not found' });
    }

    if (metadata.status !== 'in progress') {
      return res.status(400).json({ error: 'Download is not in progress' });
    }

    let downloadManager = DownloadManager.getInstance(downloadId, metadata);
    const tempPath = getTempFilePath(downloadId);
    const existingSize = await getFileSize(tempPath);
    downloadManager.currentSize = existingSize;
    await downloadManager.pause();
    res.json({ message: 'Download paused successfully' });
  } catch (err) {
    console.error('Pause error:', err);
    res.status(500).json({ error: 'Failed to pause download' });
  }
});

// Route to resume download - streams the file directly
router.get('/download/resume/:downloadId', async (req, res) => {
  const { downloadId } = req.params;

  try {
    const metadata = await loadDownloadMetadata(downloadId);
    if (!metadata) {
      return res.status(404).json({ error: 'Download not found' });
    }

    if (metadata.status !== 'paused') {
      return res.status(400).json({ error: 'Download is not paused' });
    }

    // Check if download is already active
    if (activeDownloads.has(downloadId)) {
      return res.status(409).json({ error: 'Download already in progress' });
    }

    const tempPath = getTempFilePath(downloadId);
    const existingSize = await getFileSize(tempPath);

    console.log(`Resuming download ${downloadId} from ${existingSize} bytes`);

    // Set response headers for streaming
    res.setHeader('Content-Disposition', `attachment; filename="${metadata.filename}"`);
    res.setHeader('Content-Type', metadata.contentType);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Download-Id', downloadId);

    // Set content length to total expected size
    if (metadata.totalSize) {
      res.setHeader('Content-Length', metadata.totalSize);
    }

    // Handle client disconnect
    res.on('close', () => {
      console.log('Client disconnected during resume');
      const downloadManager = activeDownloads.get(downloadId);
      if (downloadManager) {
        downloadManager.cancel();
      }
    });

    // Check if download is already completed
    if (existingSize > 0 && metadata.totalSize && existingSize >= metadata.totalSize) {
      console.log('Download already completed, streaming existing file');
      const existingStream = fsSync.createReadStream(tempPath);
      existingStream.pipe(res);
      return;
    }

    // For resume, we need to start fresh download and combine with existing data
    await resumeDownloadProcess(downloadId, metadata, res, existingSize);
  } catch (err) {
    console.error('Resume error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to resume download' });
    }
  }
});

// Helper function to continue download after pause
async function resumeDownloadProcess(downloadId, metadata, res, existingSize) {
  try {
    // Create download manager
    const downloadManager = DownloadManager.getInstance(downloadId, metadata);
    await downloadManager.resume();
    activeDownloads.set(downloadId, downloadManager);

    console.log('Fetching video info for resume...');
    const info = await ytdl.getInfo(metadata.url);

    // Handle client disconnect
    res.on('close', () => {
      console.log('Client disconnected during resume process');
      if (downloadManager) {
        downloadManager.cancel();
      }
    });

    // Start the complete download process (this will create a new complete file)
    await startResumeDownloadProcess(downloadManager, info, res, existingSize);
  } catch (err) {
    console.error('Resume download process error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to resume download' });
    }
  }
}

// Main download route
router.get('/download', async (req, res) => {
  let { url, type = 'audio', quality = 'highest', resume = 'false', downloadId } = req.query;

  console.log('Download request:', { url, type, quality, resume, downloadId });

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).send('Invalid or missing YouTube URL.');
  }

  // Generate or use existing download ID
  if (!downloadId) {
    downloadId = generateDownloadId(url, type, quality);
  }

  const tempPath = getTempFilePath(downloadId);
  let existingSize = await getFileSize(tempPath);
  if (existingSize > 0) resume = 'true';
  let downloadMetadata = null;

  // Check if resuming
  if (resume === 'true' && existingSize > 0) {
    downloadMetadata = await loadDownloadMetadata(downloadId);
    if (!downloadMetadata) {
      return res.status(404).json({ error: 'Resume data not found' });
    }
    console.log(`Resuming download from ${existingSize} bytes`);
  }

  // Check if download is already active
  if (activeDownloads.has(downloadId)) {
    return res.status(409).json({ error: 'Download already in progress' });
  }

  let downloadManager = null;

  try {
    console.log('Fetching video info...');
    const info = await ytdl.getInfo(url);
    const title = cleanFilename(info.videoDetails.title);
    const outputFilename = `${title}.${type === 'audio' ? 'mp3' : 'mp4'}`;

    // Calculate total content length
    let totalContentLength = null;
    if (type === 'video') {
      const videoFormat =
        info.formats.find((f) => f.qualityLabel === quality && f.container === 'mp4') ||
        ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });
      const audioFormat =
        info.formats.find((f) => f.audioQuality === 'AUDIO_QUALITY_HIGH' || f.itag === 140) ||
        ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

      const videoSize = videoFormat?.contentLength ? parseInt(videoFormat.contentLength, 10) : 0;
      const audioSize = audioFormat?.contentLength ? parseInt(audioFormat.contentLength, 10) : 0;
      totalContentLength = videoSize + audioSize;
    } else {
      const audioFormat =
        info.formats.find((f) => f.audioQuality === 'AUDIO_QUALITY_HIGH' || f.itag === 140) ||
        ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });
      totalContentLength = audioFormat?.contentLength ? parseInt(audioFormat.contentLength, 10) : 0;
    }
    // Create or update metadata
    if (!downloadMetadata) {
      downloadMetadata = {
        downloadId,
        url,
        type,
        quality,
        title,
        filename: outputFilename,
        contentType: type === 'audio' ? 'audio/mpeg' : 'video/mp4',
        createdAt: new Date().toISOString(),
        status: 'in progress',
        totalSize: totalContentLength,
        currentSize: existingSize
      };
    } else {
      downloadMetadata.status = 'in progress';
      downloadMetadata.lastModified = new Date().toISOString();
    }

    await saveDownloadMetadata(downloadId, downloadMetadata);

    // Create download manager
    downloadManager = DownloadManager.getInstance(downloadId, downloadMetadata);
    activeDownloads.set(downloadId, downloadManager);

    // Set response headers
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Download-Id', downloadId);

    if (totalContentLength && existingSize === 0) {
      res.setHeader('Content-Length', totalContentLength);
    }

    downloadManager.responseStream = res;

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected');
      if (downloadManager) {
        downloadManager.cancel();
      }
    });

    req.on('aborted', () => {
      console.log('Request aborted');
      if (downloadManager) {
        downloadManager.cancel();
      }
    });

    // If resuming, first send existing data
    if (existingSize > 0) {
      console.log(`Sending existing ${existingSize} bytes first`);
      const existingData = await fs.readFile(tempPath);
      res.write(existingData);
      console.log('Existing data sent, continuing with new download');
      await startResumeDownloadProcess(downloadManager, info, res, existingSize);
    } else {
      await startCompleteDownloadProcess(downloadManager, info, res, 0);
    }
  } catch (err) {
    console.error('Download error:', err.message);
    if (downloadManager) {
      await downloadManager.cleanup();
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  }
});

// Function to start the actual download process
async function startCompleteDownloadProcess(downloadManager, info, res, size = 0) {
  console.log('Starting complete download process, Size:', size);
  const { downloadId, metadata } = downloadManager;
  const { url, type, quality } = metadata;
  try {
    // Create temp file stream (overwrite for fresh start)
    const tempPath = getTempFilePath(downloadId);
    downloadManager.tempFileStream = fsSync.createWriteStream(tempPath, { flags: 'w' });

    // Progress tracker
    let bytesDownloaded = 0;
    let existingDataSent = false;

    const progressTracker = new stream.Transform({
      transform(chunk, encoding, callback) {
        if (downloadManager.isPaused || downloadManager.isCancelled) {
          return callback();
        }

        bytesDownloaded += chunk.length;
        downloadManager.currentSize = bytesDownloaded;

        // Write to temp file
        downloadManager.tempFileStream.write(chunk);

        // Send to response
        res.write(chunk);
        this.push(chunk);
        callback();
      }
    });

    // Create streams based on type
    let ffmpegArgs = [];
    let stdio = ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'];

    if (type === 'video') {
      const videoFormat =
        info.formats.find((f) => f.qualityLabel === quality && f.container === 'mp4') ||
        ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });

      const audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      const video = ytdl(url, {
        format: videoFormat,
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      downloadManager.streams = [audio, video];

      ffmpegArgs = [
        '-loglevel',
        'error',
        '-i',
        'pipe:3',
        '-i',
        'pipe:4',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov+faststart',
        '-avoid_negative_ts',
        'make_zero',
        '-fflags',
        '+genpts',
        '-f',
        'mp4',
        'pipe:1'
      ];
    } else {
      const audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      downloadManager.streams = [audio];

      ffmpegArgs = [
        '-loglevel',
        'error',
        '-i',
        'pipe:3',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-f',
        'mp3',
        'pipe:1'
      ];
      stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
    }

    // Spawn FFmpeg
    downloadManager.ffmpeg = cp.spawn('ffmpeg', ffmpegArgs, { stdio });

    downloadManager.ffmpeg.on('error', async (err) => {
      console.error('FFmpeg error:', err);
      await downloadManager.cleanup();
    });

    downloadManager.ffmpeg.on('exit', async (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (code === 0) {
        downloadManager.isCompleted = true;
        metadata.status = 'completed';
        metadata.completedAt = new Date().toISOString();
        metadata.finalSize = bytesDownloaded;
        await saveDownloadMetadata(downloadId, metadata);
        await downloadManager.complete();
      }
    });

    // Pipe streams to FFmpeg
    if (type === 'video') {
      downloadManager.streams[1].pipe(downloadManager.ffmpeg.stdio[3]); // video
      downloadManager.streams[0].pipe(downloadManager.ffmpeg.stdio[4]); // audio
    } else {
      downloadManager.streams[0].pipe(downloadManager.ffmpeg.stdio[3]); // audio
    }

    // Pipe FFmpeg output through progress tracker
    const outputStream = downloadManager.ffmpeg.stdout;
    outputStream.pipe(progressTracker);

    progressTracker.on('end', async () => {
      console.log('Download completed');

      metadata.currentSize = bytesDownloaded;
      metadata.finalSize = bytesDownloaded;
      await saveDownloadMetadata(downloadId, metadata);

      if (downloadManager.tempFileStream && !downloadManager.tempFileStream.destroyed) {
        downloadManager.tempFileStream.end();
      }
      res.end();
    });

    progressTracker.on('error', async (err) => {
      console.error('Progress tracker error:', err);
      await downloadManager.cleanup();
    });

    progressTracker.on('aborted', async () => {
      console.log('Progress tracker aborted');
      await downloadManager.cleanup();
    });
    progressTracker.on('close', async () => {
      console.log('Progress tracker closed');
      await downloadManager.cleanup();
    });
    progressTracker.on('finish', async () => {
      console.log('Progress tracker finished');
      await downloadManager.cleanup();
    });
    progressTracker.on('drain', async () => {
      console.log('Progress tracker drained');
      await downloadManager.cleanup();
    });
    progressTracker.on('data', async (chunk) => {
      metadata.currentSize = chunk.length;
      await saveDownloadMetadata(downloadId, metadata).catch(console.error);
    });
  } catch (err) {
    console.error('Complete download process error:', err);
    await downloadManager.cleanup();
  }
}

async function startResumeDownloadProcess(downloadManager, info, res, existingSize) {
  console.log('Starting resume download process, existingSize:', existingSize);
  const { downloadId, metadata } = downloadManager;
  const { url, type, quality } = metadata;

  try {
    // Create temp file stream in append mode to continue from existing data
    const tempPath = getTempFilePath(downloadId);
    downloadManager.tempFileStream = fsSync.createWriteStream(tempPath, { flags: 'a' });

    // Progress tracker
    let bytesDownloaded = existingSize; // Start from existing size

    const progressTracker = new stream.Transform({
      transform(chunk, encoding, callback) {
        if (downloadManager.isPaused || downloadManager.isCancelled) {
          return callback();
        }

        bytesDownloaded += chunk.length;
        downloadManager.currentSize = bytesDownloaded;

        // Write to temp file (append mode)
        downloadManager.tempFileStream.write(chunk);

        // Send to response
        res.write(chunk);
        this.push(chunk);
        callback();
      }
    });

    // Create streams based on type
    let ffmpegArgs = [];
    let stdio = ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'];

    if (type === 'video') {
      const videoFormat =
        info.formats.find((f) => f.qualityLabel === quality && f.container === 'mp4') ||
        ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });

      const audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      const video = ytdl(url, {
        format: videoFormat,
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      downloadManager.streams = [audio, video];

      ffmpegArgs = [
        '-loglevel',
        'error',
        '-i',
        'pipe:3',
        '-i',
        'pipe:4',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov+faststart',
        '-avoid_negative_ts',
        'make_zero',
        '-fflags',
        '+genpts',
        '-f',
        'mp4',
        'pipe:1'
      ];
    } else {
      const audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        }
      });

      downloadManager.streams = [audio];

      ffmpegArgs = [
        '-loglevel',
        'error',
        '-i',
        'pipe:3',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        '-f',
        'mp3',
        'pipe:1'
      ];
      stdio = ['pipe', 'pipe', 'pipe', 'pipe'];
    }

    // Spawn FFmpeg
    downloadManager.ffmpeg = cp.spawn('ffmpeg', ffmpegArgs, { stdio });

    downloadManager.ffmpeg.on('error', async (err) => {
      console.error('FFmpeg error:', err);
      await downloadManager.cleanup();
    });

    downloadManager.ffmpeg.on('exit', async (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (code === 0) {
        downloadManager.isCompleted = true;
        metadata.status = 'completed';
        metadata.completedAt = new Date().toISOString();
        metadata.finalSize = bytesDownloaded;
        await saveDownloadMetadata(downloadId, metadata);
        await downloadManager.complete();
      }
    });

    // Pipe streams to FFmpeg
    if (type === 'video') {
      downloadManager.streams[1].pipe(downloadManager.ffmpeg.stdio[3]); // video
      downloadManager.streams[0].pipe(downloadManager.ffmpeg.stdio[4]); // audio
    } else {
      downloadManager.streams[0].pipe(downloadManager.ffmpeg.stdio[3]); // audio
    }

    // Pipe FFmpeg output through progress tracker
    const outputStream = downloadManager.ffmpeg.stdout;
    outputStream.pipe(progressTracker);

    progressTracker.on('end', async () => {
      console.log('Download completed');

      metadata.finalSize = bytesDownloaded;
      await saveDownloadMetadata(downloadId, metadata);

      if (downloadManager.tempFileStream && !downloadManager.tempFileStream.destroyed) {
        downloadManager.tempFileStream.end();
      }
      res.end();
    });

    progressTracker.on('error', async (err) => {
      console.error('Progress tracker error:', err);
      await downloadManager.cleanup();
    });
    progressTracker.on('aborted', async () => {
      console.log('Progress tracker aborted');
      await downloadManager.cleanup();
    });
    progressTracker.on('close', async () => {
      console.log('Progress tracker closed');
      await downloadManager.cleanup();
    });
    progressTracker.on('finish', async () => {
      console.log('Progress tracker finished');
      await downloadManager.cleanup();
    });
    progressTracker.on('drain', async () => {
      console.log('Progress tracker drained');
      await downloadManager.cleanup();
    });
    let chunkSize = 0;
    progressTracker.on('data', async (chunk) => {
      chunkSize += chunk.length;
      if (chunkSize >= existingSize) {
        metadata.currentSize = chunkSize;
        await saveDownloadMetadata(downloadId, metadata).catch(console.error);
      }
    });

    // Add error handling for streams
    downloadManager.streams.forEach((stream) => {
      stream.on('error', async (err) => {
        console.error('Stream error:', err);
        await downloadManager.cleanup();
      });
    });
  } catch (err) {
    console.error('Resume download process error:', err);
    await downloadManager.cleanup();
  }
}

// Cleanup route to remove temporary files
router.delete('/download/:downloadId', async (req, res) => {
  const { downloadId } = req.params;

  try {
    // Cancel active download if exists
    if (!DownloadManager.instances.has(downloadId)) {
      await cleanupTempFiles(downloadId);
      return res.status(200).json({ message: 'Download files cleaned up successfully !!' });
    }
    const _activeDownloads = activeDownloads.get(downloadId);
    if (_activeDownloads) activeDownloads.delete(downloadId);

    let metadata = await loadDownloadMetadata(downloadId);
    const downloadManager = DownloadManager.getInstance(downloadId, metadata);
    await downloadManager.cancel();

    await cleanupTempFiles(downloadId);
    res.json({ message: 'Download files cleaned up successfully' });
  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: 'Failed to cleanup files' });
  }
});

module.exports = router;
