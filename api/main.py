"""Optional FastAPI bridge for the static GitHub Pages frontend.

This uses ytmusicapi, an unofficial community-maintained interface. It does not
extract or stream audio: every result links to the official YouTube Music player.
"""
from __future__ import annotations

import os
import time
from threading import Lock
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from ytmusicapi import YTMusic

app = FastAPI(
    title="Afterhours YouTube Music Discovery API",
    version="1.0.0",
    description="Search and discovery metadata bridge; playback stays in YouTube Music.",
)

raw_origins = os.getenv("ALLOWED_ORIGINS", "*")
allowed_origins = [origin.strip() for origin in raw_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
)

_ytmusic: YTMusic | None = None
_client_lock = Lock()
_cache: dict[str, tuple[float, Any]] = {}
_cache_lock = Lock()


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
        # Keep the small in-process cache bounded.
        if len(_cache) > 150:
            expired = [k for k, (expires, _) in _cache.items() if expires < time.monotonic()]
            for key_to_remove in expired:
                _cache.pop(key_to_remove, None)
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
    return {
        "videoId": item.get("videoId"),
        "title": str(item.get("title") or "Untitled"),
        "artists": _artists(item.get("artists")),
        "album": str(album) if album else None,
        "duration": str(item.get("duration") or "") or None,
        "thumbnail": _thumbnail(item),
        "url": url,
        "resultType": str(item.get("resultType") or ""),
    }


@app.get("/")
def root() -> dict[str, str]:
    return {
        "service": "Afterhours YouTube Music Discovery API",
        "health": "/api/health",
        "docs": "/docs",
    }


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ytmusic-discovery"}


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
    except Exception as exc:  # API should send a useful error rather than a traceback.
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
                    sections.append({
                        "title": str(row.get("title") or "Recommended for you"),
                        "items": items[:12],
                    })
        payload = {"sections": sections, "personalized": False}
        cache_set(cache_key, payload, ttl=600)
        return payload
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail="YouTube Music recommendations are currently unavailable. Check the API service logs and try again.",
        ) from exc
