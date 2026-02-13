# Dockerfile for Render.com deployment

FROM node:18-slim

# Install Python and yt-dlp
RUN apt-get update && \
    apt-get install -y python3 python3-pip && \
    pip3 install --no-cache-dir -U yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify yt-dlp installation
RUN yt-dlp --version

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy application files
COPY . .

# Create temp directory for audio files
RUN mkdir -p temp

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
