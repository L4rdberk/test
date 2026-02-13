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

// Play endpoint - streams audio directly without saving to disk
app.get('/play', async (req, res) => {
    try {
        const videoId = req.query.id;
        
        if (!videoId) {
            return res.status(400).json({ error: 'Video ID is required' });
        }

        console.log(`Streaming video: ${videoId}`);
        
        // Check if video is valid and get info
        let info;
        try {
            info = await ytdl.getInfo(videoId);
        } catch (error) {
            console.error(`Failed to get video info for ${videoId}:`, error.message);
            return res.status(404).json({ 
                error: 'Video unavailable', 
                message: 'This video may be private, deleted, or region-restricted'
            });
        }
        
        // Get the audio stream
        const audioStream = ytdl(videoId, {
            quality: 'highestaudio',
            filter: 'audioonly',
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        });
        
        // Set response headers for audio streaming
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Accept-Ranges', 'bytes');
        
        // Convert to MP3 and stream directly to response
        const ffmpegProcess = ffmpeg(audioStream)
            .audioBitrate(128)
            .format('mp3')
            .on('start', () => {
                console.log(`Started streaming: ${videoId}`);
            })
            .on('error', (err) => {
                console.error('FFmpeg streaming error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Streaming failed' });
                }
            })
            .on('end', () => {
                console.log(`Finished streaming: ${videoId}`);
            });
        
        // Pipe directly to response
        ffmpegProcess.pipe(res, { end: true });
        
    } catch (error) {
        console.error('Play error:', error);
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Failed to process video', 
                message: error.message 
            });
        }
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
