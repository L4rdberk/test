const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const execPromise = promisify(exec);

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
    if (!input) return null;
    
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

// Check if yt-dlp is installed
async function checkYtDlp() {
    try {
        await execPromise('yt-dlp --version');
        return true;
    } catch (error) {
        return false;
    }
}

// Get video info using yt-dlp
async function getVideoInfo(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    try {
        const { stdout } = await execPromise(
            `yt-dlp --dump-json --no-warnings "${url}"`,
            { maxBuffer: 10 * 1024 * 1024 }
        );
        
        const info = JSON.parse(stdout);
        return {
            id: info.id,
            title: info.title,
            duration: info.duration,
            thumbnail: info.thumbnail,
            uploader: info.uploader,
            view_count: info.view_count
        };
    } catch (error) {
        console.error('yt-dlp info error:', error.message);
        throw new Error('Could not fetch video information. Video may be unavailable.');
    }
}

// Search videos using yt-dlp
async function searchVideos(query, limit = 10) {
    try {
        const { stdout } = await execPromise(
            `yt-dlp "ytsearch${limit}:${query}" --dump-json --no-warnings --no-playlist`,
            { maxBuffer: 10 * 1024 * 1024 }
        );
        
        // Parse each line as separate JSON
        const results = stdout
            .trim()
            .split('\n')
            .filter(line => line)
            .map(line => {
                try {
                    const info = JSON.parse(line);
                    return {
                        id: info.id,
                        title: info.title,
                        duration: formatDuration(info.duration || 0),
                        thumbnail: info.thumbnail,
                        url: `https://www.youtube.com/watch?v=${info.id}`
                    };
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean);
        
        return results;
    } catch (error) {
        console.error('Search error:', error.message);
        throw new Error('Search failed. Please try again.');
    }
}

// Download and convert audio using yt-dlp
async function downloadAudio(videoId, filepath) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    try {
        await execPromise(
            `yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${filepath}" "${url}" --no-warnings --no-playlist`,
            { 
                maxBuffer: 50 * 1024 * 1024,
                timeout: 180000 // 3 minutes
            }
        );
        
        return true;
    } catch (error) {
        console.error('Download error:', error.message);
        throw new Error('Failed to download audio. Video may be too long or unavailable.');
    }
}

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'ASCEND YouTube Player Backend v3.0',
        engine: 'yt-dlp',
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
                const info = await getVideoInfo(videoId);
                const result = {
                    id: info.id,
                    title: info.title,
                    duration: formatDuration(info.duration),
                    thumbnail: info.thumbnail,
                    url: `https://www.youtube.com/watch?v=${info.id}`
                };
                
                return res.json({ results: [result] });
            } catch (error) {
                console.error('Error fetching video info:', error.message);
                return res.status(404).json({ 
                    error: 'Video unavailable', 
                    message: error.message
                });
            }
        }
        
        // Perform a text search
        try {
            const results = await searchVideos(query);
            res.json({ results });
        } catch (searchError) {
            console.error('Search error:', searchError.message);
            return res.status(500).json({ 
                error: 'Search failed', 
                message: searchError.message
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
        const input = req.query.id;
        
        if (!input) {
            return res.status(400).json({ error: 'Video ID or URL is required' });
        }

        // Extract video ID from input (handles both IDs and URLs)
        const videoId = extractVideoId(input);
        
        if (!videoId) {
            return res.status(400).json({ error: 'Invalid video ID or URL' });
        }

        console.log(`Processing video: ${videoId}`);
        
        // Check if file already exists
        const existingFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(videoId));
        if (existingFiles.length > 0) {
            const streamUrl = `${req.protocol}://${req.get('host')}/stream/${existingFiles[0]}`;
            console.log(`Using cached file: ${existingFiles[0]}`);
            
            // Get video info for title
            try {
                const info = await getVideoInfo(videoId);
                return res.json({
                    success: true,
                    url: streamUrl,
                    title: info.title,
                    cached: true
                });
            } catch (e) {
                return res.json({
                    success: true,
                    url: streamUrl,
                    cached: true
                });
            }
        }
        
        // Generate unique filename (without extension, yt-dlp will add .mp3)
        const baseFilename = `${videoId}_${crypto.randomBytes(4).toString('hex')}`;
        const filepath = path.join(TEMP_DIR, baseFilename);
        
        // Get video info
        let info;
        try {
            info = await getVideoInfo(videoId);
            console.log(`Downloading: ${info.title}`);
        } catch (error) {
            console.error(`Failed to get video info for ${videoId}:`, error.message);
            return res.status(404).json({ 
                error: 'Video unavailable', 
                message: error.message
            });
        }
        
        // Download and convert
        try {
            await downloadAudio(videoId, filepath);
            
            // Find the actual file (yt-dlp adds .mp3 extension)
            const actualFilename = `${baseFilename}.mp3`;
            const actualFilepath = path.join(TEMP_DIR, actualFilename);
            
            if (!fs.existsSync(actualFilepath)) {
                throw new Error('File was not created successfully');
            }

            const streamUrl = `${req.protocol}://${req.get('host')}/stream/${actualFilename}`;
            
            console.log(`Download complete: ${actualFilename}`);
            
            res.json({
                success: true,
                url: streamUrl,
                title: info.title,
                duration: formatDuration(info.duration)
            });
            
        } catch (downloadError) {
            console.error('Download error:', downloadError.message);
            
            // Clean up failed download
            const possibleFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(baseFilename));
            possibleFiles.forEach(f => {
                try {
                    fs.unlinkSync(path.join(TEMP_DIR, f));
                } catch (e) {}
            });
            
            return res.status(500).json({ 
                error: 'Download failed', 
                message: downloadError.message
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
app.get('/health', async (req, res) => {
    const tempFiles = fs.readdirSync(TEMP_DIR).length;
    const ytdlpInstalled = await checkYtDlp();
    
    res.json({ 
        status: ytdlpInstalled ? 'healthy' : 'warning',
        ytdlp_installed: ytdlpInstalled,
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
async function startServer() {
    const ytdlpInstalled = await checkYtDlp();
    
    if (!ytdlpInstalled) {
        console.error('❌ ERROR: yt-dlp is not installed!');
        process.exit(1);
    }
    
    app.listen(PORT, () => {
        console.log(`ASCEND YouTube Player Backend v3.0 running on port ${PORT}`);
        console.log(`yt-dlp installed and ready`);
        console.log(`Endpoints:`);
        console.log(`   - Search: GET /search?q=query`);
        console.log(`   - Play: GET /play?id=videoId`);
        console.log(`   - Stream: GET /stream/:filename`);
        console.log(`   - Health: GET /health`);
        console.log(`Server ready for requests`);
    });
}

startServer();

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    process.exit(0);
});
