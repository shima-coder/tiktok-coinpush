FROM debian:bookworm
RUN apt-get update && apt-get install -y wget gnupg ca-certificates ffmpeg xvfb x11vnc fluxbox && rm -rf /var/lib/apt/lists/*
# Chromium
RUN apt-get update && apt-get install -y chromium && rm -rf /var/lib/apt/lists/*

ENV OVERLAY_URL="http://your-render-app.onrender.com/overlay.html"
ENV TIKTOK_RTMP_URL="rtmp://push.tiktok.com/live/" \    TIKTOK_STREAM_KEY="REPLACE_ME"

COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
