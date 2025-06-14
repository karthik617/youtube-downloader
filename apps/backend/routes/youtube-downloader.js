const express = require('express');
const ytdl = require('@distube/ytdl-core');
const sanitize = require('sanitize-filename');
const cp = require('child_process');
const stream = require('stream');
const axios = require('axios');
const { Readable } = require('stream');

const router = express.Router();

// Global error handler to prevent crashes from unhandled stream errors
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
    console.log('Suppressed pipe error (client disconnected)');
    return;
  }
  console.error('Uncaught Exception:', err);
  // Don't exit the process, just log it
});

process.on('unhandledRejection', (reason, promise) => {
  if (reason?.code === 'EPIPE' || reason?.code === 'ECONNRESET') {
    console.log('Suppressed pipe rejection (client disconnected)');
    return;
  }
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Helper function to safely handle stream errors
const safeStreamHandler = (stream, name, clientDisconnected) => {
  if (!stream) return;

  const errorHandler = (err) => {
    if (!clientDisconnected() && err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
      console.error(`${name} error:`, err.message);
    }
  };

  const closeHandler = () => {
    stream.removeAllListeners('error');
    stream.removeAllListeners('close');
  };

  stream.on('error', errorHandler);
  stream.on('close', closeHandler);

  return { errorHandler, closeHandler };
};

router.get('/download', async (req, res) => {
  const { url, type = 'audio', quality = 'highest' } = req.query;
  console.log('url::', url, '\n', 'type::', type, '\n', 'quality::', quality);

  if (!url || !ytdl.validateURL(url)) {
    return res.status(400).send('Invalid or missing YouTube URL.');
  }

  let ffmpeg = null;
  let audio = null;
  let video = null;
  let isCleanedUp = false;
  let totalContentLength = null;
  let streamHandlers = [];

  // Enhanced cleanup function with proper error handling
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    console.log('Starting cleanup...');

    try {
      // Clean up stream handlers first
      streamHandlers.forEach((handler) => {
        try {
          if (handler.closeHandler) handler.closeHandler();
        } catch (e) {
          // Ignore cleanup errors
        }
      });
      streamHandlers = [];

      // Close streams with error suppression
      if (audio && !audio.destroyed) {
        audio.removeAllListeners();
        try {
          audio.destroy();
        } catch (e) {
          // Ignore destruction errors
        }
      }
      if (video && !video.destroyed) {
        video.removeAllListeners();
        try {
          video.destroy();
        } catch (e) {
          // Ignore destruction errors
        }
      }

      // Handle FFmpeg process
      if (ffmpeg && !ffmpeg.killed) {
        // Remove all listeners to prevent further error events
        ffmpeg.removeAllListeners();

        // Close stdin pipes if they exist with error suppression
        ['stdin', 'stdout', 'stderr'].forEach((pipe) => {
          if (ffmpeg[pipe] && !ffmpeg[pipe].destroyed) {
            ffmpeg[pipe].removeAllListeners();
            try {
              ffmpeg[pipe].destroy();
            } catch (e) {
              // Ignore pipe destruction errors
            }
          }
        });

        // Close stdio pipes
        if (ffmpeg.stdio) {
          ffmpeg.stdio.forEach((pipe, index) => {
            if (pipe && !pipe.destroyed) {
              pipe.removeAllListeners();
              try {
                pipe.destroy();
              } catch (e) {
                // Ignore stdio destruction errors
              }
            }
          });
        }

        // Kill the process
        try {
          ffmpeg.kill('SIGTERM');

          // Force kill after timeout
          setTimeout(() => {
            if (ffmpeg && !ffmpeg.killed) {
              try {
                ffmpeg.kill('SIGKILL');
              } catch (e) {
                // Ignore kill errors
              }
            }
          }, 1000);
        } catch (e) {
          // Ignore kill errors
        }
      }
    } catch (err) {
      // Suppress cleanup errors completely
    }
  };

  // Handle client disconnect - set up early
  let clientDisconnected = false;

  req.on('close', () => {
    console.warn('Client disconnected');
    clientDisconnected = true;
    cleanup();
  });

  req.on('aborted', () => {
    console.warn('Request aborted');
    clientDisconnected = true;
    cleanup();
  });

  res.on('close', () => {
    console.log('Response closed');
    clientDisconnected = true;
    cleanup();
  });

  res.on('error', (err) => {
    console.error('Response error:', err.message);
    clientDisconnected = true;
    cleanup();
  });

  try {
    // Check if client is still connected
    if (clientDisconnected) {
      console.log('Client already disconnected, aborting');
      return;
    }

    const info = await ytdl.getInfo(url);
    const title = sanitize(info.videoDetails.title);
    const outputFilename = `${title}.${type === 'audio' ? 'mp3' : 'mp4'}`;

    // Check again after async operation
    if (clientDisconnected) {
      console.log('Client disconnected during info fetch');
      return;
    }

    // Set headers early
    res.setHeader('Content-Disposition', `attachment; filename="${outputFilename}"`);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // res.removeHeader('Content-Length');

    // For video type
    let totalContentLength = null;

    if (type === 'video') {
      // Find video format by quality
      const videoFormat =
        info.formats.find((f) => f.qualityLabel === quality && f.container === 'mp4') ||
        ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });

      // Find audio format - you use highestaudio
      const audioFormat =
        info.formats.find((f) => f.audioQuality === 'AUDIO_QUALITY_HIGH' || f.itag === 140) ||
        ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

      // Sum contentLength if available
      const videoSize =
        videoFormat && videoFormat.contentLength ? parseInt(videoFormat.contentLength, 10) : 0;
      const audioSize =
        audioFormat && audioFormat.contentLength ? parseInt(audioFormat.contentLength, 10) : 0;

      if (videoSize && audioSize) {
        totalContentLength = videoSize + audioSize;
      } else if (videoSize) {
        totalContentLength = videoSize;
      } else if (audioSize) {
        totalContentLength = audioSize;
      }
    } else {
      // Audio only
      const audioFormat =
        info.formats.find((f) => f.audioQuality === 'AUDIO_QUALITY_HIGH' || f.itag === 140) ||
        ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

      if (audioFormat && audioFormat.contentLength) {
        totalContentLength = parseInt(audioFormat.contentLength, 10);
      }
    }

    // Set Content-Length if known
    if (totalContentLength) {
      res.setHeader('Content-Length', totalContentLength);
    } else {
      res.removeHeader('Content-Length');
    }

    let ffmpegArgs = [];
    let stdio = ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'];
    let thumbnailBuffer = null;
    let hasThumbnail = false;

    if (type === 'video') {
      const format =
        info.formats.find((f) => f.qualityLabel === quality && f.container === 'mp4') ||
        ytdl.chooseFormat(info.formats, { quality: 'highestvideo' });

      // Check client connection before creating streams
      if (clientDisconnected) return;

      audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });

      // Set up safe error handling for audio stream
      streamHandlers.push(safeStreamHandler(audio, 'Audio', () => clientDisconnected));

      video = ytdl(url, {
        format,
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });

      // Set up safe error handling for streams
      streamHandlers.push(safeStreamHandler(audio, 'Audio', () => clientDisconnected));
      streamHandlers.push(safeStreamHandler(video, 'Video', () => clientDisconnected));

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
      // Audio processing
      if (clientDisconnected) return;

      audio = ytdl(url, {
        quality: 'highestaudio',
        highWaterMark: 1 << 25,
        requestOptions: {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      });

      const thumbnails = info.videoDetails.thumbnails;
      const thumbnailUrl =
        thumbnails && thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url : null;

      if (thumbnailUrl && !clientDisconnected) {
        try {
          console.log('Fetching thumbnail...');
          const thumbnailReq = await axios.get(thumbnailUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });

          // Check if client is still connected after thumbnail fetch
          if (clientDisconnected) {
            console.log('Client disconnected during thumbnail fetch');
            return;
          }

          thumbnailBuffer = Buffer.from(thumbnailReq.data);

          // Detect image format from buffer
          let imageFormat = 'jpeg'; // default
          if (thumbnailBuffer[0] === 0x89 && thumbnailBuffer[1] === 0x50) {
            imageFormat = 'png';
          } else if (thumbnailBuffer[0] === 0xff && thumbnailBuffer[1] === 0xd8) {
            imageFormat = 'jpeg';
          } else if (thumbnailBuffer[0] === 0x47 && thumbnailBuffer[1] === 0x49) {
            imageFormat = 'gif';
          } else if (thumbnailBuffer.slice(0, 4).toString() === 'RIFF') {
            imageFormat = 'webp';
          }

          hasThumbnail = true;
          console.log('Thumbnail fetched, size:', thumbnailBuffer.length, 'format:', imageFormat);
          thumbnailBuffer.imageFormat = imageFormat;
        } catch (thumbError) {
          console.error('Thumbnail fetch failed:', thumbError.message);
          thumbnailBuffer = null;
          hasThumbnail = false;
        }
      }

      if (hasThumbnail && thumbnailBuffer && !clientDisconnected) {
        // Audio with thumbnail - handle different image formats
        const imageFormat = thumbnailBuffer.imageFormat || 'jpeg';
        console.log('Processing thumbnail with format:', imageFormat);

        let videoCodec, inputFormat;

        switch (imageFormat) {
          case 'png':
            videoCodec = 'mjpeg';
            inputFormat = ['-f', 'image2pipe', '-vcodec', 'png'];
            break;
          case 'webp':
            videoCodec = 'mjpeg';
            inputFormat = ['-f', 'image2pipe', '-vcodec', 'webp'];
            break;
          case 'gif':
            videoCodec = 'mjpeg';
            inputFormat = ['-f', 'image2pipe', '-vcodec', 'gif'];
            break;
          default: // jpeg
            videoCodec = 'mjpeg';
            inputFormat = ['-f', 'image2pipe', '-vcodec', 'mjpeg'];
            break;
        }

        ffmpegArgs = [
          '-loglevel',
          'error',
          '-i',
          'pipe:3',
          ...inputFormat,
          '-i',
          'pipe:4',
          '-map',
          '0:a',
          '-map',
          '1:v',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '192k',
          '-c:v',
          videoCodec,
          '-vf',
          'scale=600:600:force_original_aspect_ratio=decrease',
          '-id3v2_version',
          '3',
          '-metadata:s:v',
          'title=Album cover',
          '-metadata:s:v',
          'comment=Cover (front)',
          '-disposition:v',
          'attached_pic',
          '-f',
          'mp3',
          'pipe:1'
        ];
      } else {
        // Fallback to audio-only
        console.log('Using audio-only mode (no thumbnail)');
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
    }

    // Final check before spawning FFmpeg
    if (clientDisconnected) {
      console.log('Client disconnected before FFmpeg spawn');
      return;
    }

    // Spawn FFmpeg with better error handling
    ffmpeg = cp.spawn('ffmpeg', ffmpegArgs, { stdio });

    // Set up FFmpeg error handling with proper cleanup
    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err.message);
      if (!clientDisconnected && !res.headersSent) {
        res.status(500).send('Processing error');
      }
      cleanup();
    });

    ffmpeg.on('exit', (code, signal) => {
      console.log(`FFmpeg exited with code ${code}, signal: ${signal}`);
      if (code !== 0 && !clientDisconnected && !res.headersSent) {
        res.status(500).send('Processing failed');
      }
    });

    // Handle stderr with error suppression for client disconnects
    ffmpeg.stderr?.on('data', (data) => {
      if (!clientDisconnected) {
        const stderr = data.toString();
        // Only log non-pipe errors if client is still connected
        if (!stderr.includes('Broken pipe') && !stderr.includes('EPIPE')) {
          console.error('FFmpeg stderr:', stderr);
        }
      }
    });

    ffmpeg.stderr?.on('error', (err) => {
      // Suppress all stderr errors to prevent crashes
    });

    // Handle stdout errors with better cleanup
    ffmpeg.stdout?.on('error', (err) => {
      // Only log if not a pipe error and client is connected
      if (!clientDisconnected && err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
        console.error('FFmpeg stdout error:', err.message);
      }
    });

    // Set up stream error handlers before piping - remove the old ones
    // These are now handled by safeStreamHandler

    // Check one more time before piping
    if (clientDisconnected) {
      console.log('Client disconnected before piping');
      cleanup();
      return;
    }

    // Pipe streams to FFmpeg with error handling
    try {
      if (type === 'video') {
        video.pipe(ffmpeg.stdio[3], { end: false });
        audio.pipe(ffmpeg.stdio[4], { end: false });

        // Handle end events
        video.on('end', () => ffmpeg.stdio[3]?.end());
        audio.on('end', () => ffmpeg.stdio[4]?.end());
      } else {
        audio.pipe(ffmpeg.stdio[3], { end: false });
        audio.on('end', () => ffmpeg.stdio[3]?.end());

        if (hasThumbnail && thumbnailBuffer) {
          const thumbStream = Readable.from(thumbnailBuffer);
          streamHandlers.push(
            safeStreamHandler(thumbStream, 'Thumbnail', () => clientDisconnected)
          );
          thumbStream.pipe(ffmpeg.stdio[4], { end: false });
          thumbStream.on('end', () => ffmpeg.stdio[4]?.end());
        }
      }
    } catch (pipeError) {
      console.error('Pipe error:', pipeError.message);
      cleanup();
      return;
    }

    // Use pipeline with better error handling and client disconnect checks
    const pipeline = stream.pipeline(ffmpeg.stdout, res, (err) => {
      if (err) {
        // Only log pipeline errors if not due to client disconnect
        if (
          !clientDisconnected &&
          err.code !== 'EPIPE' &&
          err.code !== 'ERR_STREAM_PREMATURE_CLOSE'
        ) {
          console.error('Pipeline error:', err.message);
        }
      } else if (!clientDisconnected) {
        console.log('Stream completed successfully');
      }
      cleanup();
    });

    // Handle pipeline abort on client disconnect
    req.on('close', () => {
      if (pipeline && typeof pipeline.destroy === 'function') {
        pipeline.destroy();
      }
    });
  } catch (err) {
    console.error('Download error:', err.message);
    cleanup();
    if (!clientDisconnected && !res.headersSent) {
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  }
});

module.exports = router;
