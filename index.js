const express = require('express');
const cors = require('cors');
const ytdl = require('ytdl-core');
const ytsr = require('ytsr');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const { promisify } = require('util');
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
    
    // Try to extract from various YouTube URL formats
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

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'ASCEND YouTube Player Backend',
        endpoints: {
            search: '/search?q=query',
            play: '/play?id=videoId',
            stream: '/stream/:filename'
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
                const info = await ytdl.getInfo(videoId);
                const result = {
                    id: videoId,
                    title: info.videoDetails.title,
                    duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
                    thumbnail: info.videoDetails.thumbnails[0]?.url || '',
                    url: `https://www.youtube.com/watch?v=${videoId}`
                };
                
                return res.json({ results: [result] });
            } catch (error) {
                console.error('Error fetching video info:', error.message);
                // If direct fetch fails, fall through to search
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
        
        // Get video info with better error handling
        let info;
        try {
            info = await ytdl.getInfo(videoId);
        } catch (error) {
            console.error(`Failed to get video info for ${videoId}:`, error.message);
            
            // Try alternative method
            try {
                info = await ytdl.getBasicInfo(videoId);
            } catch (altError) {
                return res.status(404).json({ 
                    error: 'Video unavailable', 
                    message: 'Video may be private, deleted, or region-restricted'
                });
            }
        }
        
        console.log(`Downloading: ${info.videoDetails.title}`);
        
        // Download and convert
        try {
            const audioStream = ytdl(videoId, {
                quality: 'highestaudio',
                filter: 'audioonly',
                requestOptions: {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept-Language': 'en-US,en;q=0.9'
                    }
                }
            });
            
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Download timeout'));
                }, 120000); // 2 minute timeout
                
                ffmpeg(audioStream)
                    .audioBitrate(128)
                    .format('mp3')
                    .on('start', () => {
                        console.log(`Started conversion: ${filename}`);
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
            
            const streamUrl = `${req.protocol}://${req.get('host')}/stream/${filename}`;
            
            res.json({
                success: true,
                url: streamUrl,
                title: info.videoDetails.title
            });
            
        } catch (downloadError) {
            console.error('Download error:', downloadError.message);
            
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            
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

// Stream endpoint - serves the MP3 file
app.get('/stream/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(TEMP_DIR, filename);
    
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: 'Audio file not found' });
    }
    
    const stat = fs.statSync(filepath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
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
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'audio/mpeg',
            'Accept-Ranges': 'bytes'
        };
        res.writeHead(200, head);
        fs.createReadStream(filepath).pipe(res);
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`ASCEND YouTube Player Backend running on port ${PORT}`);
    console.log(`Endpoints:`);
    console.log(`   - Search: GET /search?q=query`);
    console.log(`   - Play: GET /play?id=videoId`);
    console.log(`   - Stream: GET /stream/:filename`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});
