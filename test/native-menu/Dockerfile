# Image for test/native-menu.mjs: Playwright's Linux image (its Chromium matches the
# playwright package in package.json) plus a mouse driver, a screen grabber and OCR.
ARG PW=1.63.0
FROM mcr.microsoft.com/playwright:v${PW}-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends xdotool imagemagick tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*
