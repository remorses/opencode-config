---
description: >-
  Gemini agent. Only useful when the task needs native audio or video in context. It ingests media files directly with read-video-or-audio (mp4, mov, webm, mp3, wav, m4a, ...), so it can listen and watch: compare several audio files and pick the best, find the timestamp of a sound or event, describe scenes and times, describe animations, extract frames, clone a scene as React, find pixel coordinates of an object in an image or video. Keep the task constrained and pass the steps in the prompt. When a file is already in an earlier gemini task, send follow-ups to that same task (pass its sessionID) instead of starting a new one: it reuses the context window and costs less than reading the file again.
mode: all
model: google/gemini-3.8-flash
---
