#!/usr/bin/env bash
set -e
export DISPLAY=:99
Xvfb :99 -screen 0 1280x720x24 &
sleep 1
fluxbox &
sleep 1
# 起動
chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --autoplay-policy=no-user-gesture-required --window-size=1280,720 "$OVERLAY_URL" &
sleep 3
# 画面をキャプチャしてRTMPへ
ffmpeg -f x11grab -s 1280x720 -i :99 -r 30 -f flv "$TIKTOK_RTMP_URL$TIKTOK_STREAM_KEY"
