import { useState } from 'react';
import { Download, Music, Video, Loader2 } from 'lucide-react';

const YouTubeDownloader = () => {
  const [url, setUrl] = useState('');
  const [type, setType] = useState('audio');
  const [quality, setQuality] = useState('highest');
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  const handleDownload = async () => {
    if (!url.trim()) {
      setError('Please enter a YouTube URL');
      return;
    }

    setIsDownloading(true);
    setError('');
    setProgress('Preparing download...');

    try {
      // Create the download URL
      const downloadUrl = `http://localhost:3001/api/download?${new URLSearchParams({
        url: url.trim(),
        type,
        quality
      })}`;

      setProgress('Starting download...');

      // Use a different approach: create a hidden link and trigger download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.style.display = 'none';

      // Set download attribute to suggest filename
      const videoId = extractVideoId(url);
      const extension = type === 'audio' ? 'mp3' : 'mp4';
      link.download = `youtube_${videoId}.${extension}`;

      document.body.appendChild(link);

      // Trigger the download
      link.click();

      // Clean up
      document.body.removeChild(link);

      setProgress('Download started! Check your downloads folder.');

      // Reset after a delay
      setTimeout(() => {
        setProgress('');
        setIsDownloading(false);
        setUrl('');
        setType('audio');
        setQuality('highest');
      }, 3000);
    } catch (err) {
      console.error('Download failed:', err);
      setError('Download failed. Please try again.');
      setIsDownloading(false);
      setUrl('');
      setType('audio');
      setQuality('highest');
      setProgress('');
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
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <div className="flex items-center gap-3 mb-6">
        <Download className="w-8 h-8 text-red-600" />
        <h1 className="text-2xl font-bold text-gray-800">YouTube Downloader</h1>
      </div>

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
        <br />
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
        <br />
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
        <br />
        {/* Download Button */}
        <button
          onClick={handleDownload}
          disabled={isDownloading || !url.trim() || !isValidYouTubeUrl(url)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {isDownloading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Download className="w-5 h-5" />
              Download {type === 'audio' ? 'Audio' : 'Video'}
            </>
          )}
        </button>

        {/* Progress/Error Messages */}
        {progress && (
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
            <p className="text-blue-800 text-sm">{progress}</p>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
        )}
      </div>

      {/* Instructions */}
      <div className="mt-6 p-4 bg-gray-50 rounded-md">
        <h3 className="font-medium text-gray-800 mb-2">Instructions:</h3>
        <ul className="text-sm text-gray-600 space-y-1">
          <li>Paste a YouTube video URL</li>
          <li>Choose between audio (MP3) or video (MP4) download</li>
          <li>Select your preferred quality</li>
          <li>Click download and wait for the file to save</li>
        </ul>
      </div>
    </div>
  );
};

export default YouTubeDownloader;
