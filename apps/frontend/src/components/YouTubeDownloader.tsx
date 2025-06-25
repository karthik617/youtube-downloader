import { useState, useEffect, useRef } from 'react';
import { Download, Music, Video, Loader2, Trash2, Pause, Play } from 'lucide-react';

const YouTubeDownloader = () => {
  const [url, setUrl] = useState('');
  const [type, setType] = useState('audio');
  const [quality, setQuality] = useState('highest');
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [downloadId, setDownloadId] = useState('');
  const abortController = new AbortController();
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState<{
    filename: string;
    progress: number;
    currentSize: number;
    totalSize: number;
    status: string;
  } | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [downloads, setDownloads] = useState<any[]>([]);
  const statusIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const BASE_URL = 'http://192.168.0.103:3001';

  // Load saved downloads from localStorage equivalent (using state)
  useEffect(() => {
    // In a real app, you might want to load this from a backend or persistent storage
    const savedDownloads: [] = [];
    setDownloads(savedDownloads);
  }, []);

  // Clean up intervals on unmount
  useEffect(() => {
    return () => {
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current);
      }
    };
  }, []);

  const handleDownload = async () => {
    if (!url.trim()) {
      setError('Please enter a YouTube URL');
      return;
    }

    setIsDownloading(true);
    setError('');
    setProgress('Preparing download...');
    setDownloadProgress(0);
    setIsPaused(false);

    try {
      const downloadUrl = `${BASE_URL}/api/download?${new URLSearchParams({
        url: url.trim(),
        type,
        quality
      })}`;

      setProgress('Starting download...');
      // Start the download
      const response = await fetch(downloadUrl, { signal: abortController.signal });

      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }

      const disposition = response.headers.get('Content-Disposition');
      let filename = `youtube_${extractVideoId(url)}.${type === 'audio' ? 'mp3' : 'mp4'}`;

      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="(.+?)"/);

        if (match && match[1]) {
          filename = match[1];
        }
      }
      // Get download ID from response headers
      const responseDownloadId = response.headers.get('X-Download-Id');
      if (responseDownloadId) {
        setDownloadId(responseDownloadId);
        startStatusTracking(responseDownloadId);
      }

      // Create blob URL for download
      const blob = await response.blob();
      const downloadUrl2 = window.URL.createObjectURL(blob);

      // Create download link
      const link = document.createElement('a');
      link.href = downloadUrl2;
      link.style.display = 'none';

      link.download = filename;

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up blob URL
      window.URL.revokeObjectURL(downloadUrl2);

      setProgress('Download completed successfully!');
      setDownloadProgress(100);

      // Add to downloads list
      const newDownload = {
        id: responseDownloadId || Date.now().toString(),
        url: url.trim(),
        type,
        quality,
        filename: link.download,
        status: 'completed',
        progress: 100,
        createdAt: new Date().toISOString()
      };

      setDownloads((prev) => [newDownload, ...prev.slice(0, 9)]); // Keep last 10 downloads

      // Reset after delay
      setTimeout(() => {
        resetForm();
      }, 3000);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Download cancelled');
        setError('Download cancelled');
      } else {
        console.log('Download failed:', err);
        setError('Download failed. Please try again.');
      }
      setIsDownloading(false);
      setProgress('');
      setDownloadProgress(0);
    }
  };

  const startStatusTracking = (id: any) => {
    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
    }

    statusIntervalRef.current = setInterval(async () => {
      try {
        const response = await fetch(`${BASE_URL}/api/download/status/${id}`);
        if (response.ok) {
          const status = await response.json();
          setDownloadStatus(status);
          setDownloadProgress(status.progress || 0);

          if (
            statusIntervalRef.current &&
            (status.status === 'completed' ||
              status.status === 'failed' ||
              status.status === 'paused')
          ) {
            clearInterval(statusIntervalRef.current);
            if (status.status === 'completed') {
              setProgress('Download completed!');
            }
          } else {
            setProgress(`Downloading... ${status.progress || 0}%`);
          }
        }
      } catch (err) {
        console.error('Status check failed:', err);
      }
    }, 1000);
  };

  const pauseDownload = async () => {
    if (!downloadId) return;

    try {
      setIsPaused(true);
      setProgress('Pausing download...');

      // Cancel the current request
      if (abortController && !abortController.signal.aborted) {
        abortController.abort();
      }

      // Call backend pause endpoint
      const response = await fetch(`${BASE_URL}/api/download/pause/${downloadId}`, {
        method: 'POST'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Pause failed: ${response.status}`);
      }

      // Update status
      const responseStatus = await fetch(`${BASE_URL}/api/download/status/${downloadId}`);
      if (responseStatus.ok) {
        const status = await responseStatus.json();
        setDownloadStatus(status);
        setDownloadProgress(status.progress || 0);
        setProgress(`Download paused at ${status.progress || 0}%`);
      }

      // Stop status tracking
      if (statusIntervalRef.current) {
        clearInterval(statusIntervalRef.current);
        statusIntervalRef.current = null;
      }
    } catch (err: any) {
      console.error('Pause failed:', err);
      setError(`Failed to pause download: ${err?.message}`);
      setIsPaused(false);
    }
  };

  const resumeDownload = async () => {
    if (!downloadId) return;

    setIsPaused(false);
    setProgress('Resuming download...');
    setIsDownloading(true);

    try {
      const response = await fetch(`${BASE_URL}/api/download/resume/${downloadId}`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Resume failed: ${response.status}`);
      }

      // Get filename from response headers
      const disposition = response.headers.get('Content-Disposition');
      let filename = `youtube_${extractVideoId(url)}.${type === 'audio' ? 'mp3' : 'mp4'}`;

      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="(.+?)"/);
        if (match && match[1]) {
          filename = match[1];
        }
      }

      // Get download ID from response headers (should be the same)
      const responseDownloadId = response.headers.get('X-Download-Id');
      if (responseDownloadId) {
        setDownloadId(responseDownloadId);
        startStatusTracking(responseDownloadId);
      }

      // Create blob from the complete response
      const blob = await response.blob();
      const downloadUrl2 = window.URL.createObjectURL(blob);

      // Create download link
      const link = document.createElement('a');
      link.href = downloadUrl2;
      link.download = filename;
      link.style.display = 'none';

      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // Clean up blob URL
      window.URL.revokeObjectURL(downloadUrl2);

      setProgress('Download completed successfully!');
      setDownloadProgress(100);
      setIsDownloading(false);

      // Add to downloads list
      const newDownload = {
        id: responseDownloadId || downloadId,
        url: url.trim(),
        type,
        quality,
        filename: filename,
        status: 'completed',
        progress: 100,
        createdAt: new Date().toISOString()
      };

      setDownloads((prev) => [newDownload, ...prev.slice(0, 9)]);

      // Reset after delay
      setTimeout(() => {
        resetForm();
      }, 3000);
    } catch (err: any) {
      console.error('Resume failed:', err);
      setError(`Failed to resume download: ${err?.message}`);
      setIsPaused(false);
      setIsDownloading(false);
    }
  };

  const cancelDownload = async () => {
    if (abortController) {
      abortController.abort();
    }
    setIsPaused(false);
    setIsDownloading(false);

    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
    }

    // Cleanup backend files if download ID exists
    if (downloadId) {
      try {
        await fetch(`${BASE_URL}/api/download/${downloadId}`, {
          method: 'DELETE'
        });
      } catch (err) {
        console.error('Cleanup failed:', err);
      }
    }

    resetForm();
  };

  const resetForm = () => {
    setIsDownloading(false);
    setProgress('');
    setDownloadProgress(0);
    setDownloadId('');
    setDownloadStatus(null);
    setIsPaused(false);
    setUrl('');
    setType('audio');
    setQuality('highest');

    if (statusIntervalRef.current) {
      clearInterval(statusIntervalRef.current);
    }
  };

  const cleanupDownload = async (id: any) => {
    try {
      await fetch(`${BASE_URL}/api/download/${id}`, {
        method: 'DELETE'
      });

      setDownloads((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      console.error('Cleanup failed:', err);
    }
  };

  const extractVideoId = (url: string) => {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
    return match ? match[1] : 'video';
  };

  const isValidYouTubeUrl = (url: string) => {
    return /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/.test(url);
  };

  return (
    <div className="max-w-4xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="flex items-center gap-3 mb-6">
        <Download className="w-8 h-8 text-red-600" />
        <h1 className="text-2xl font-bold text-gray-800">YouTube Downloader</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Download Form */}
        <div className="space-y-4">
          {/* URL Input */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">YouTube URL</label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              disabled={isDownloading}
            />
            {url && !isValidYouTubeUrl(url) && (
              <p className="text-red-500 text-sm mt-1">Please enter a valid YouTube URL</p>
            )}
          </div>
          <p></p>
          {/* Type Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Download Type</label>
            <div className="flex gap-4 justify-center">
              <button
                onClick={() => setType('audio')}
                disabled={isDownloading}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border transition-colors ${
                  type === 'audio'
                    ? 'bg-red-500 text-white border-red-500'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Music className="w-4 h-4" />
                Audio (MP3)
              </button>
              <button
                onClick={() => setType('video')}
                disabled={isDownloading}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border transition-colors ${
                  type === 'video'
                    ? 'bg-red-500 text-white border-red-500'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
              >
                <Video className="w-4 h-4" />
                Video (MP4)
              </button>
            </div>
          </div>
          <p></p>
          {/* Quality Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
              disabled={isDownloading || type === 'audio'}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
            >
              <option value="highest">Highest</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="360p">360p</option>
              <option value="lowest">Lowest</option>
            </select>
          </div>
          <p></p>
          {/* Download Controls */}
          <div className="flex-1 flex gap-2 justify-center">
            {!isDownloading ? (
              <button
                onClick={handleDownload}
                disabled={!url.trim() || !isValidYouTubeUrl(url)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                <Download className="w-5 h-5" />
                Download {type === 'audio' ? 'Audio' : 'Video'}
              </button>
            ) : (
              <>
                {!isPaused ? (
                  <button
                    onClick={pauseDownload}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 transition-colors"
                  >
                    <Pause className="w-5 h-5" />
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={resumeDownload}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                  >
                    <Play className="w-5 h-5" />
                    Resume
                  </button>
                )}
                <button
                  onClick={cancelDownload}
                  className="px-4 py-3 bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          {/* Status Messages */}
          {progress && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
              <div className="flex justify-center items-center gap-2">
                {isDownloading && !isPaused && <Loader2 className="w-4 h-4 animate-spin" />}
                <p className="text-blue-800 text-sm">{progress}</p>
              </div>
              <div className="flex w-full bg-gray-200 rounded-full h-4">
                <div
                  className="bg-red-600 rounded-full transition-all duration-300 h-4"
                  style={{ width: `${downloadProgress}%` }}
                ></div>
              </div>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-800 text-sm">{error}</p>
            </div>
          )}

          {/* Download Status Details */}
          {downloadStatus && (
            <div className="p-3 bg-gray-50 border border-gray-200 rounded-md">
              <h4 className="font-medium text-gray-800 mb-2">Download Details</h4>
              <div className="text-sm text-gray-600 space-y-1">
                <p className="text-align-left">
                  <strong>File:</strong> {downloadStatus.filename}
                </p>
                {/* <p className='text-align-left'><strong>Progress:</strong> {downloadStatus.progress}%</p> */}
                {downloadStatus.currentSize && (
                  <p className="text-align-left">
                    <strong>Downloaded:</strong> {(downloadStatus.currentSize / 1000000).toFixed(2)}{' '}
                    MB
                  </p>
                )}
                {downloadStatus.totalSize && (
                  <p className="text-align-left">
                    <strong>Total Size:</strong> {(downloadStatus.totalSize / 1000000).toFixed(2)}{' '}
                    MB
                  </p>
                )}
                <p className="text-align-left">
                  <strong>Status:</strong> {downloadStatus.status}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Download History */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-gray-800">Recent Downloads</h2>

          {downloads.length === 0 ? (
            <div className="p-4 text-center text-gray-500 bg-gray-50 rounded-md">
              No downloads yet
            </div>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {downloads.map((download) => (
                <div key={download.id} className="p-3 bg-gray-50 rounded-md border">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 text-align-left">
                      <p
                        className="text-sm font-medium text-gray-800 truncate"
                        style={{ marginBlock: '0' }}
                      >
                        {download.filename}
                      </p>
                      <p className="text-xs text-gray-500" style={{ marginBlock: '0' }}>
                        {download.type.toUpperCase()} • {download.quality} • {download.status}
                      </p>
                      <p className="text-xs text-gray-400" style={{ marginBlock: '0' }}>
                        {new Date(download.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-2">
                      <button
                        onClick={() => cleanupDownload(download.id)}
                        className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                        title="Remove"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Instructions */}
      <div className="mt-6 p-4 bg-gray-50 rounded-md">
        <h3 className="font-medium text-gray-800 mb-2">Instructions:</h3>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>Paste a YouTube video URL</li>
          <li>Choose between audio (MP3) or video (MP4) download</li>
          <li>Select your preferred quality (video only)</li>
          <li>Click download and monitor progress</li>
          <li>Use pause/resume for large downloads</li>
          <li>View download history and manage files</li>
        </ul>
      </div>
    </div>
  );
};

export default YouTubeDownloader;
