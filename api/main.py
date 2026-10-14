"""Experimental, personal YouTube Music search + audio-stream player API.

Search/recommendation metadata comes from ytmusicapi. Playback resolves a public
YouTube video to an available audio-only format with yt-dlp and proxies the
bytes to the browser on demand. Nothing is written to disk. This is unofficial,
fragile, and is not an officially supported YouTube Music streaming interface.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from threading import Lock
from typing import Any
from urllib.parse import quote, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import StreamingResponse
from yt_dlp import YoutubeDL
from ytmusicapi import YTMusic

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("afterhours")

app = FastAPI(
    title="Afterhours Personal Music Player API",
    version="2.0.0",
    description=(
        "Experimental personal music player. Uses unofficial metadata and stream "
        "resolution; public tracks only, no cookies, DRM handling, or file storage."
    ),
)

raw_origins = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["Accept", "Content-Type", "Range", "If-Range"],
    expose_headers=["Accept-Ranges", "Content-Range", "Content-Length"],
)

_video_id_re = re.compile(r"^[A-Za-z0-9_-]{11}$")
_ytmusic: YTMusic | None = None
_client_lock = Lock()
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = Lock()

# Direct media URLs expire. Keep them only in memory, briefly, and resolve them
# again when needed. These values never reach the browser.
_stream_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_stream_cache_lock = Lock()
STREAM_URL_TTL_SECONDS = 180


def get_client() -> YTMusic:
    global _ytmusic
    if _ytmusic is None:
        with _client_lock:
            if _ytmusic is None:
                _ytmusic = YTMusic()
    return _ytmusic


def cache_get(key: str) -> Any | None:
    now = time.monotonic()
    with _cache_lock:
        item = _cache.get(key)
        if not item:
            return None
        expires_at, value = item
        if expires_at < now:
            _cache.pop(key, None)
            return None
        return value


def cache_set(key: str, value: Any, ttl: int) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic() + ttl, value)
        if len(_cache) > 150:
            now = time.monotonic()
            for old_key in [k for k, (expiry, _) in _cache.items() if expiry < now]:
                _cache.pop(old_key, None)
            while len(_cache) > 150:
                _cache.pop(next(iter(_cache)))


def _artists(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result: list[dict[str, str]] = []
    for artist in value:
        if isinstance(artist, str) and artist.strip():
            result.append({"name": artist.strip()})
        elif isinstance(artist, dict) and artist.get("name"):
            result.append({"name": str(artist["name"])})
    return result


def _thumbnail(item: dict[str, Any]) -> str | None:
    value = item.get("thumbnail") or item.get("thumbnailUrl")
    if isinstance(value, str) and value.startswith("https://"):
        return value
    thumbs = item.get("thumbnails")
    if isinstance(thumbs, list):
        for candidate in reversed(thumbs):
            if isinstance(candidate, dict):
                url = candidate.get("url")
                if isinstance(url, str) and url.startswith("https://"):
                    return url
    return None


def _music_url(item: dict[str, Any]) -> str | None:
    video_id = item.get("videoId")
    if video_id:
        return f"https://music.youtube.com/watch?v={quote(str(video_id), safe='')}"
    playlist_id = item.get("playlistId")
    if playlist_id:
        return f"https://music.youtube.com/playlist?list={quote(str(playlist_id), safe='')}"
    browse_id = item.get("browseId")
    if browse_id:
        return f"https://music.youtube.com/browse/{quote(str(browse_id), safe='')}"
    return None


def normalize_item(item: Any) -> dict[str, Any] | None:
    if not isinstance(item, dict):
        return None
    url = _music_url(item)
    if not url:
        return None
    album_value = item.get("album")
    album = album_value.get("name") if isinstance(album_value, dict) else album_value
    video_id = item.get("videoId")
    return {
        "videoId": str(video_id) if video_id else None,
        "title": str(item.get("title") or "Untitled"),
        "artists": _artists(item.get("artists")),
        "album": str(album) if album else None,
        "duration": str(item.get("duration") or "") or None,
        "thumbnail": _thumbnail(item),
        "url": url,
        "resultType": str(item.get("resultType") or ""),
    }


def _resolve_audio_info(video_id: str, force_refresh: bool = False) -> dict[str, Any]:
    """Resolve metadata to an audio-only URL; yt-dlp does not save a file."""
    now = time.monotonic()
    with _stream_cache_lock:
        cached = _stream_cache.get(video_id)
        if not force_refresh and cached and cached[0] > now:
            return cached[1]

    options: dict[str, Any] = {
        # Prefer AAC/M4A for iPhone Safari, falling back to another audio-only
        # format if YouTube does not expose an AAC stream for a particular item.
        "format": "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "socket_timeout": 20,
        "cachedir": False,
    }
    watch_url = f"https://www.youtube.com/watch?v={quote(video_id, safe='')}"
    try:
        with YoutubeDL(options) as ydl:
            info = ydl.extract_info(watch_url, download=False)
    except Exception as exc:
        logger.warning("Audio stream resolution failed for video %s: %s", video_id, type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Could not resolve an audio stream for this track. Try another song or retry later.",
        ) from exc

    if not isinstance(info, dict) or not info.get("url"):
        raise HTTPException(status_code=502, detail="No playable audio stream was returned for this track.")

    # Only proxy HTTPS Google video media hosts. The client cannot pass an
    # arbitrary URL, so this endpoint is not a general-purpose open proxy.
    parsed = urlparse(str(info["url"]))
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or not (host == "googlevideo.com" or host.endswith(".googlevideo.com")):
        raise HTTPException(status_code=502, detail="The resolved media host is not supported.")

    audio_codec = str(info.get("acodec") or "")
    if audio_codec.lower() == "none":
        raise HTTPException(status_code=502, detail="The selected result did not contain an audio stream.")

    resolved = {
        "url": str(info["url"]),
        "headers": info.get("http_headers") if isinstance(info.get("http_headers"), dict) else {},
        "mime_type": str(info.get("mime_type") or "application/octet-stream"),
        "ext": str(info.get("ext") or ""),
        "title": str(info.get("title") or ""),
    }
    with _stream_cache_lock:
        _stream_cache[video_id] = (time.monotonic() + STREAM_URL_TTL_SECONDS, resolved)
        if len(_stream_cache) > 50:
            for old_key, (expiry, _) in list(_stream_cache.items()):
                if expiry <= time.monotonic():
                    _stream_cache.pop(old_key, None)
            while len(_stream_cache) > 50:
                _stream_cache.pop(next(iter(_stream_cache)))
    return resolved


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Afterhours Personal Music Player API",
        "health": "/api/health",
        "docs": "/docs",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "afterhours-personal-player", "streaming": "experimental"}


@app.get("/api/search")
def search(
    q: str = Query(min_length=1, max_length=160),
    limit: int = Query(default=20, ge=1, le=30),
) -> dict[str, Any]:
    query = " ".join(q.split())
    if not query:
        raise HTTPException(status_code=422, detail="Search query cannot be empty.")
    cache_key = f"search:{query.casefold()}:{limit}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        raw_results = get_client().search(query, filter="songs", limit=limit)
        items = [normalized for row in raw_results if (normalized := normalize_item(row))]
        payload = {"query": query, "items": items}
        cache_set(cache_key, payload, ttl=180)
        return payload
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("YouTube Music search failed")
        raise HTTPException(
            status_code=502,
            detail="YouTube Music search is currently unavailable. Check the API service logs and try again.",
        ) from exc


@app.get("/api/recommendations")
def recommendations() -> dict[str, Any]:
    cache_key = "recommendations:home"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        home = get_client().get_home()
        sections: list[dict[str, Any]] = []
        if isinstance(home, list):
            for row in home:
                if not isinstance(row, dict):
                    continue
                contents = row.get("contents")
                if not isinstance(contents, list):
                    continue
                items = [normalized for value in contents if (normalized := normalize_item(value))]
                if items:
                    sections.append({"title": str(row.get("title") or "Recommended for you"), "items": items[:12]})
        payload = {"sections": sections, "personalized": False}
        cache_set(cache_key, payload, ttl=600)
        return payload
    except Exception as exc:
        logger.exception("YouTube Music recommendations failed")
        raise HTTPException(
            status_code=502,
            detail="YouTube Music recommendations are currently unavailable. Check the API service logs and try again.",
        ) from exc


@app.api_route("/api/stream/{video_id}", methods=["GET"])
async def stream_audio(video_id: str, request: Request) -> StreamingResponse:
    """Resolve a public track and proxy its audio bytes to the native audio tag.

    Supports HTTP Range requests so iOS can seek. No media file is retained.
    Stream URL resolution is experimental and may fail when YouTube changes.
    """
    if not _video_id_re.fullmatch(video_id):
        raise HTTPException(status_code=400, detail="Invalid video ID.")

    range_value = request.headers.get("range")
    stream_info = await asyncio.to_thread(_resolve_audio_info, video_id)

    async def open_upstream(info: dict[str, Any]) -> tuple[httpx.AsyncClient, httpx.Response]:
        client = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(60.0, connect=20.0),
        )
        headers: dict[str, str] = {}
        allowed = {"user-agent", "accept", "accept-language", "referer", "origin"}
        for key, value in info.get("headers", {}).items():
            if str(key).lower() in allowed and isinstance(value, str):
                headers[str(key)] = value
        headers.setdefault("Accept", "*/*")
        headers.setdefault("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
        if range_value:
            headers["Range"] = range_value
        try:
            upstream_request = client.build_request("GET", info["url"], headers=headers)
            upstream = await client.send(upstream_request, stream=True)
            return client, upstream
        except Exception:
            await client.aclose()
            raise

    try:
        client, upstream = await open_upstream(stream_info)
        # A cached signed URL can occasionally expire early; resolve once more.
        if upstream.status_code in (401, 403, 410):
            await upstream.aclose()
            await client.aclose()
            stream_info = await asyncio.to_thread(_resolve_audio_info, video_id, True)
            client, upstream = await open_upstream(stream_info)
        if upstream.status_code not in (200, 206, 416):
            status = upstream.status_code
            await upstream.aclose()
            await client.aclose()
            logger.warning("Upstream audio request returned HTTP %s for %s", status, video_id)
            raise HTTPException(status_code=502, detail=f"The upstream audio stream returned HTTP {status}.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unable to open upstream audio stream for %s", video_id)
        raise HTTPException(status_code=502, detail="Could not open the audio stream. Please retry.") from exc

    response_headers: dict[str, str] = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    for header in ("content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"):
        value = upstream.headers.get(header)
        if value:
            response_headers[header] = value
    response_headers.setdefault("accept-ranges", "bytes")
    response_headers.setdefault("content-type", stream_info.get("mime_type") or "application/octet-stream")

    async def body():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(body(), status_code=upstream.status_code, headers=response_headers)
