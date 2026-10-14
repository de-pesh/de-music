# Afterhours — YouTube Music Discovery (GitHub Pages)

A mobile-first, dark music discovery companion for iPhone Safari. The UI is a static site suitable for **GitHub Pages**. An optional FastAPI service uses the community-maintained `ytmusicapi` library to fetch song search results and the public YouTube Music home feed.

**This is a discovery companion, not an audio streaming client.** Every track opens in the official YouTube Music player. It does not extract audio, bypass Premium restrictions, or promise background playback inside Safari.

## How this works

- **GitHub Pages frontend:** `index.html`, `styles.css`, `app.js`, `config.js` and `favicon.svg`.
- **Static-only mode:** works with no backend. Searching and the mood cards open YouTube Music search pages. Recommendation tiles are curated search shortcuts, not live personalized recommendations.
- **Optional API:** `api/main.py` searches YouTube Music and reads its home feed through `ytmusicapi`. The frontend displays those results in-page once the API is deployed and configured.
- **Personalization:** the included API uses unauthenticated access and must not be described as your account-personalized feed. Account-specific features require a carefully configured server-side authentication setup; never put tokens, cookies or auth JSON in this public repo or in `config.js`.

`ytmusicapi` is unofficial and can stop working when YouTube Music changes. This is not a Google/YouTube product or an officially supported API.

## 1. Publish the frontend on GitHub Pages

1. Create a GitHub repository, for example `afterhours-music`.
2. Upload the contents of this project to the repository root. Do not upload only the ZIP file.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, select **Deploy from a branch**, choose `main` and `/(root)`, then save.
5. Wait for the Pages deployment to finish. The site address will look like `https://YOUR-USERNAME.github.io/afterhours-music/`.
6. Open that HTTPS address in Safari on your iPhone.

You can use the static site immediately, before deploying the API. `config.js` is deliberately configured for static-only mode by default.

## 2. Optional: enable live search results and YT Music home rows

GitHub Pages cannot run Python or FastAPI. To show fetched results *inside the website*, deploy the included API separately. The frontend stays on GitHub Pages; the API can be hosted by a Python-capable service such as Render.

### Deploy the API on Render

1. Push this project to GitHub first.
2. In Render, create a new **Web Service** from the same repository.
3. Set **Root Directory** to `api`.
4. Set the build command to `pip install -r requirements.txt`.
5. Set the start command to `uvicorn main:app --host 0.0.0.0 --port $PORT`.
6. After deployment, check `https://YOUR-API.onrender.com/api/health`. It should return `{"status":"ok","service":"ytmusic-discovery"}`.
7. For production, set the API environment variable `ALLOWED_ORIGINS` to your exact GitHub Pages **origin**, for example `https://YOUR-USERNAME.github.io` (no repository path, no trailing slash). Use a comma-separated list if you have more than one site origin. The included `render.yaml` uses `*` only to make first-time testing easier; restrict it before relying on the service.
8. Edit `config.js` in the GitHub repo and set:

   ```js
   window.AFTERHOURS_CONFIG = {
     API_BASE_URL: "https://YOUR-API.onrender.com"
   };
   ```

9. Commit and push. GitHub Pages will publish the new frontend. Reload it on the iPhone.

Search results should appear in the page, and `/api/recommendations` will supply home-feed rows if the upstream interface is working. If the API reports an upstream error, direct YouTube Music links still work.

## Run the optional API locally

Python 3.10+ recommended.

```bash
cd api
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000/docs` to inspect the API. For local frontend testing, set `API_BASE_URL` to `http://127.0.0.1:8000` in `config.js`; add your local frontend origin to `ALLOWED_ORIGINS` if needed. A browser cannot access your computer's `localhost` from your iPhone unless the API runs on an address reachable by the phone.

## Endpoints

- `GET /api/health`
- `GET /api/search?q=radiohead&limit=20`
- `GET /api/recommendations`

Responses are cached in process for a short period to avoid repeatedly calling the upstream service. A service restart clears this cache.

## iPhone background playback limitation

This site does not play or proxy YouTube Music audio. Selecting a result opens that track in YouTube Music. For background playback when the iPhone is locked, use the official YouTube Music app and supported account features. Static GitHub Pages alone cannot run a backend, and the unofficial `ytmusicapi` project is for metadata/discovery, not for bypassing playback restrictions.
