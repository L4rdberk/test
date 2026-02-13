#!/usr/bin/env bash
# build.sh - Render.com build script

set -e

echo "Installing dependencies..."

# Install yt-dlp via pip (Python is pre-installed on Render)
echo "Installing yt-dlp..."
pip install -U yt-dlp

# Verify yt-dlp installation
echo "Verifying yt-dlp..."
yt-dlp --version

# Install Node.js dependencies
echo "Installing Node.js packages..."
npm install

echo "Build complete!"
