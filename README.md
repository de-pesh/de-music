# Afterhours — Experimental Personal Audio Player

This version changes the old discovery launcher into an experimental in-page player. Search and recommendation metadata are fetched with `ytmusicapi`. Tapping a song sets the page's native HTML audio player to `/api/stream/{video_id}`; the FastAPI backend resolves a currently available audio-only format with `yt-dlp` and proxies it to the browser in chunks, including byte-range requests for seeking. Audio is not saved as a file on the server.

**Important limitations:** This is an unofficial experiment, not an official YouTube Music streaming integration. It may stop working when YouTube changes its player delivery, challenge checks, or formats. It only tries public videos without browser cookies, account tokens, DRM handling, or a download-to-file feature. iPhone Safari background playback and lock-screen controls must be tested on the actual device and are not guaranteed. Use only content you have permission to access.

## Architecture

- **GitHub Pages:** static frontend (`index.html`, `styles.css`, `app.js`, `config.js`).
- **Render:** FastAPI API (`api/main.py`) handles search, the public home recommendation rows, and stream proxying.
- **ytmusicapi:** unofficial search/recommendation metadata.
- **yt-dlp + Deno/EJS:** attempts to resolve available audio-only formats on demand. The stream URL is cached in memory for only 3 minutes, then re-resolved. No audio file is written to disk.
- **Safari:** plays the backend response in a normal `<audio>` element. Media Session actions are registered where the browser supports them.

## Update the existing GitHub repository

1. Download and extract this project ZIP.
2. Upload/replace these files in the **root** of your existing repository: `index.html`, `styles.css`, `app.js`, `config.js`, `favicon.svg`, `.nojekyll`, `README.md`, and `render.yaml`.
3. Replace the `api` folder with this ZIP's `api` folder. Do not nest it under another folder; the file path must be `api/main.py`.
4. Open `config.js` and set `API_BASE_URL` to your actual Render URL, for example:

   ```js
   window.AFTERHOURS_CONFIG = {
     API_BASE_URL: "https://YOUR-ACTUAL-SERVICE.onrender.com"
   };
   ```

   Do not put `/api` at the end. Do not leave `YOUR-RENDER-SERVICE` in the URL.
5. Commit the changes to `main`. GitHub Pages will publish the frontend update automatically.

## Update the existing Render service

Use the service you already deployed (`afterhours-ytmusic-api`). You do not need to create a second service.

1. Open Render Dashboard → the service → **Settings**.
2. Keep **Root Directory** set to `api`.
3. Set **Build Command** to:

   ```sh
   pip install -r requirements.txt && curl -fsSL https://deno.land/install.sh | sh
   ```

4. Set **Start Command** to:

   ```sh
   export PATH="$HOME/.deno/bin:$PATH" && uvicorn main:app --host 0.0.0.0 --port $PORT
   ```

5. In **Environment**, keep/set `ALLOWED_ORIGINS` to the GitHub Pages origin only, with no path or trailing slash. Example: `https://YOUR-GITHUB-USERNAME.github.io`. If using a custom domain, use that origin instead.
6. Save changes and deploy the latest commit. Wait for Render to show **Live**.

The Deno runtime and the yt-dlp EJS dependency are included because current yt-dlp YouTube support may require JavaScript challenge solving. The runtime install is part of the build command; its binary is added to `PATH` in the start command.

## Verify the API

Replace the host with your Render service URL.

- `https://YOUR-SERVICE.onrender.com/api/health` — returns JSON if the API is running.
- `https://YOUR-SERVICE.onrender.com/api/search?q=radiohead&limit=5` — search results.
- `https://YOUR-SERVICE.onrender.com/api/recommendations` — available home-feed rows.
- `https://YOUR-SERVICE.onrender.com/api/stream/VIDEO_ID` — streams audio bytes for an 11-character video ID. Test playback from the site rather than typing this URL into the browser.

## Manual YouTube Music URL fallback

The page includes a collapsible manual fallback below the main search bar. If the `ytmusicapi` search or recommendation endpoints fail but the Render service and `/api/stream/{video_id}` endpoint are still reachable, open the YouTube Music search in a new tab, copy a single track URL, paste it, and choose **Play in this page**. It accepts YouTube Music/YouTube watch URLs and short links, extracts the video ID in the browser, and avoids depending on the search API to find metadata.

If the entire Render API is unavailable, an ordinary YouTube Music page URL cannot be played by the browser's native `<audio>` element: it is not a direct audio-stream URL. In that case **Open pasted link** opens the official YouTube Music page. The manual fallback does not bypass stream resolution, nor does it guarantee playback.

## Use on iPhone

1. Open your GitHub Pages HTTPS URL in Safari.
2. Search for a track.
3. Tap the result. The website's own bottom player should start buffering and then play without opening YouTube Music.
4. Once playback has started, lock the phone to test background audio. Check lock-screen artwork and controls where iOS Safari supports them.

Tap Play a second time if Safari rejects the initial play request. A cold Render free instance may need time to wake up before search or playback responds.

## Troubleshooting

- **The website says `SET API URL`:** edit `config.js` and set the Render URL; commit to GitHub.
- **Search does not load:** open `/api/health`, verify the Render service says Live, check `ALLOWED_ORIGINS`, and inspect Render logs.
- **Track shows `STREAM ERROR`:** check Render logs for `Audio stream resolution failed` or `Upstream audio request returned`. Retry another result. This often means YouTube changed the stream challenge/format, or the selected video has no usable audio-only stream.
- **Playback starts but seeking fails:** the endpoint forwards Range requests, but the upstream format can change; try another track.
- **Screen locks and music pauses:** Safari/iOS behavior varies. Make sure you tapped Play on the webpage before locking. Media Session controls are best-effort only.
- **Deno cannot be found:** confirm the exact Render start command above and check that the Deno install step finished successfully in the build logs.

This is intentionally experimental. There is no guarantee of uptime, uninterrupted playback, all tracks, personalized recommendations, or continued compatibility with YouTube.
