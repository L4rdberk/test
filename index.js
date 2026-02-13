const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const ytsr = require('ytsr');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create temporary directory for audio files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Clean up old files periodically (files older than 2 hours)
setInterval(() => {
    const now = Date.now();
    fs.readdir(TEMP_DIR, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(TEMP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (err) return;
                if (now - stats.mtimeMs > 7200000) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}, 600000);

// User agent rotation to avoid detection
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Helper function to format duration
function formatDuration(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Extract video ID from URL or return the input if it's already an ID
function extractVideoId(input) {
    // If it's already a video ID (11 characters)
    if (input.length === 11 && /^[a-zA-Z0-9_-]+$/.test(input)) {
        return input;
    }
    
    // Try to extract from various YouTube URL formats (including YouTube Music)
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        /(?:music\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:m\.youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
        /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/
    ];
    
    for (const pattern of patterns) {
        const match = input.match(pattern);
        if (match) return match[1];
    }
    
    return null;
}

// Retry mechanism with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            
            const delay = baseDelay * Math.pow(2, i);
            console.log(`Retry ${i + 1}/${maxRetries} after ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Enhanced getInfo with multiple fallback strategies
async function getVideoInfo(videoId) {
    // Strategy 1: Try with rotated user agent
    try {
        return await ytdl.getInfo(videoId, {
            requestOptions: {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                }
            }
        });
    } catch (error) {
        console.log('Strategy 1 failed, trying alternative methods...');
    }

    // Strategy 2: Try getBasicInfo (faster, less detection)
    try {
        return await ytdl.getBasicInfo(videoId, {
            requestOptions: {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                }
            }
        });
    } catch (error) {
        console.log('Strategy 2 failed...');
    }

    // Strategy 3: Try with different video URL format
    try {
        return await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`, {
            requestOptions: {
                headers: {
                    'User-Agent': getRandomUserAgent(),
                    'Referer': 'https://www.youtube.com/',
                    'Origin': 'https://www.youtube.com'
                }
            }
        });
    } catch (error) {
        console.log('Strategy 3 failed...');
    }

    throw new Error('All strategies failed. Video may be unavailable, private, or region-restricted.');
}

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'ASCEND YouTube Player Backend',
        version: '2.0.0',
        endpoints: {
            search: '/search?q=query',
            play: '/play?id=videoId',
            stream: '/stream/:filename',
            health: '/health'
        }
    });
});

// Search endpoint
app.get('/search', async (req, res) => {
    try {
        const query = req.query.q;
        
        if (!query) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        console.log(`Searching for: ${query}`);
        
        // Check if query is a YouTube URL
        const videoId = extractVideoId(query);
        
        if (videoId) {
            // If it's a direct URL, get info for that video
            try {
                const info = await retryWithBackoff(() => getVideoInfo(videoId));
                const result = {
                    id: videoId,
                    title: info.videoDetails.title,
                    duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
                    thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || '',
                    url: `https://www.youtube.com/watch?v=${videoId}`
                };
                
                return res.json({ results: [result] });
            } catch (error) {
                console.error('Error fetching video info:', error.message);
                return res.status(404).json({ 
                    error: 'Video unavailable', 
                    message: 'Could not fetch video. It may be private, deleted, or region-restricted.'
                });
            }
        }
        
        // Perform a text search
        try {
            const searchResults = await ytsr(query, { limit: 10 });
            
            const results = searchResults.items
                .filter(item => item.type === 'video')
                .slice(0, 10)
                .map(video => ({
                    id: video.id,
                    title: video.title,
                    duration: video.duration || 'Unknown',
                    thumbnail: video.bestThumbnail?.url || video.thumbnails?.[0]?.url || '',
                    url: video.url
                }));
            
            res.json({ results });
        } catch (searchError) {
            console.error('Search error:', searchError.message);
            return res.status(500).json({ 
                error: 'Search failed', 
                message: 'Unable to search at this time. Please try again.'
            });
        }
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ 
            error: 'Search failed', 
            message: error.message 
        });
    }
});

// Play endpoint - downloads, converts, saves to temp, returns stream URL
app.get('/play', async (req, res) => {
    try {
        const videoId = req.query.id;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }

        console.log(`Processing video: ${videoId}`);
        
        // Check if file already exists
        const existingFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId));
        if (existingFiles.length > 0) {
            const streamUrl = `${req.protocol}://${req.get('host')}/stream/${existingFiles[0]}`;
            console.log(`Using cached file: ${existingFiles[0]}`);
            return res.json({
                success: true,
                url: streamUrl
            });
        }
        
        // Generate unique filename
        const filename = `${videoId}_${crypto.randomBytes(4).toString('hex')}.mp3`;
        const filepath = path.join(TEMP_DIR, filename);
        
        // Get video info with retry and fallback
        let info;
        try {
            info = await retryWithBackoff(() => getVideoInfo(videoId), 3, 2000);
        } catch (error) {
            console.error(`Failed to get video info for ${videoId}:`, error.message);
            return res.status(404).json({ 
                error: 'Video unavailable', 
                message: 'Could not access this video. It may be private, deleted, region-restricted, or YouTube is blocking requests. Try again in a few minutes.'
            });
        }
        
        console.log(`Downloading: ${info.videoDetails.title}`);
        
        // Download and convert with enhanced options
        try {
            const audioStream = ytdl(videoId, {
                quality: 'highestaudio',
                filter: 'audioonly',
                requestOptions: {
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': '*/*',
                        'Accept-Encoding': 'gzip, deflate',
                        'Connection': 'keep-alive',
                        'Range': 'bytes=0-',
                    }
                }
            });

            // Handle stream errors
            audioStream.on('error', (error) => {
                console.error('Stream error:', error);
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                }
            });
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Download timeout - video may be too long or connection is slow'));
                }, 180000); // 3 minute timeout
                
                ffmpeg(audioStream)
                    .audioBitrate(128)
                    .format('mp3')
                    .audioChannels(2)
                    .audioFrequency(44100)
                    .on('start', (commandLine) => {
                        console.log(`Started conversion: ${filename}`);
                        console.log(`FFmpeg command: ${commandLine}`);
                    })
                    .on('progress', (progress) => {
                        if (progress.percent) {
                            console.log(`Processing: ${progress.percent.toFixed(2)}%`);
                        }
                    })
                    .on('end', () => {
                        clearTimeout(timeout);
                        console.log(`Conversion complete: ${filename}`);
                        resolve();
                    })
                    .on('error', (err) => {
                        clearTimeout(timeout);
                        console.error('FFmpeg error:', err);
                        reject(err);
                    })
                    .save(filepath);
            });
            
            // Verify file was created
            if (!fs.existsSync(filepath)) {
                throw new Error('File was not created successfully');
            }

            const streamUrl = `${req.protocol}://${req.get('host')}/stream/${filename}`;
            
            res.json({
                success: true,
                url: streamUrl,
                title: info.videoDetails.title,
                duration: formatDuration(parseInt(info.videoDetails.lengthSeconds))
            });
            
        } catch (downloadError) {
            console.error('Download error:', downloadError.message);
            
            // Clean up failed download
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            
            return res.status(500).json({ 
                error: 'Download failed', 
                message: 'Failed to download audio. The video may be unavailable or too large. Try another video.'
            });
        }
        
    } catch (error) {
        console.error('Play error:', error);
        res.status(500).json({ 
            error: 'Failed to process video', 
            message: error.message 
        });
    }
});

// Stream endpoint - serves the MP3 file with range support
app.get('/stream/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(TEMP_DIR, filename);
    
    // Security check
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Audio file not found. It may have been cleaned up.' });
    }
    
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    // Support range requests for better streaming
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filepath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'audio/mpeg',
            'Cache-Control': 'public, max-age=3600',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'audio/mpeg',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
        };
        res.writeHead(200, head);
        fs.createReadStream(filepath).pipe(res);
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    const tempFiles = fs.readdirSync(TEMP_DIR).length;
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        cachedFiles: tempFiles,
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB'
        },
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`ASCEND YouTube Player Backend running on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`   - Search: GET /search?q=query`);
    console.log(`   - Play: GET /play?id=videoId`);
    console.log(`   - Stream: GET /stream/:filename`);
    console.log(`   - Health: GET /health`);
    console.log(`Server ready for requests`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    process.exit(0);
});
