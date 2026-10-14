(() => {
  "use strict";

  const config = window.AFTERHOURS_CONFIG || {};
  const rawApiBase = String(config.API_BASE_URL || "").trim().replace(/\/$/, "");
  const apiBase = rawApiBase && !rawApiBase.includes("YOUR-RENDER-SERVICE") ? rawApiBase : "";
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");
  const searchNote = document.getElementById("search-note");
  const manualFallback = document.getElementById("manual-fallback");
  const manualUrlInput = document.getElementById("manual-url-input");
  const manualPlayButton = document.getElementById("manual-play-button");
  const manualOpenButton = document.getElementById("manual-open-button");
  const manualSearchButton = document.getElementById("manual-search-button");
  const manualNote = document.getElementById("manual-note");
  const resultsSection = document.getElementById("results-section");
  const resultsTitle = document.getElementById("results-title");
  const resultsMeta = document.getElementById("results-meta");
  const resultsList = document.getElementById("results-list");
  const recommendationsGrid = document.getElementById("recommendations-grid");
  const recommendationsMeta = document.getElementById("recommendations-meta");
  const connectionCard = document.getElementById("connection-card");
  const connectionStatus = document.getElementById("connection-status");
  const toast = document.getElementById("toast");
  const audio = document.getElementById("audio-player");
  const playerArt = document.getElementById("player-art");
  const playerTitle = document.getElementById("player-title");
  const playerArtist = document.getElementById("player-artist");
  const playerStatus = document.getElementById("player-status");
  const statusLed = document.getElementById("status-led");
  const playPauseButton = document.getElementById("play-pause");
  const previousButton = document.getElementById("previous-track");
  const nextButton = document.getElementById("next-track");
  const seekbar = document.getElementById("seekbar");
  const currentTimeLabel = document.getElementById("current-time");
  const durationLabel = document.getElementById("duration-time");

  let toastTimer;
  let playbackQueue = [];
  let queueIndex = -1;
  let currentTrack = null;
  let sourceFailureShown = false;

  if (apiBase) {
    connectionCard.classList.add("connected");
    connectionStatus.textContent = "API CONFIGURED";
    searchNote.textContent = "Tap a song to play it here. Stream resolution is experimental.";
    recommendationsMeta.textContent = "Loading feed…";
    setPlayerStatus("READY");
    loadRecommendations();
  } else {
    connectionStatus.textContent = "SET API URL";
    searchNote.textContent = "Edit config.js and set API_BASE_URL to your Render service URL.";
    setPlayerStatus("CONFIG NEEDED");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      showToast("Enter a song, artist or album first.");
      input.focus();
      return;
    }
    if (!apiBase) {
      showToast("Set your Render URL in config.js first.");
      return;
    }
    searchTracks(query);
  });

  manualPlayButton.addEventListener("click", () => {
    const parsed = parseYouTubeTrackUrl(manualUrlInput.value);
    if (!parsed) {
      showToast("Paste a valid YouTube Music or YouTube track URL first.");
      manualUrlInput.focus();
      return;
    }
    if (!apiBase) {
      manualFallback.open = true;
      showToast("The custom player needs the Render stream API. Use Open pasted link as the fallback.");
      return;
    }
    const track = {
      videoId: parsed.videoId,
      title: `Manual track (${parsed.videoId})`,
      artists: [],
      album: null,
      duration: null,
      thumbnail: null,
      url: parsed.url,
      resultType: "manual-url"
    };
    manualNote.textContent = "Trying this URL through the custom player. If it fails, the stream endpoint may be unavailable or unable to resolve this video.";
    startTrack(track, [track], 0);
  });

  manualOpenButton.addEventListener("click", () => {
    const safeUrl = parseAllowedYouTubeUrl(manualUrlInput.value);
    if (!safeUrl) {
      showToast("Paste a valid YouTube Music or YouTube URL first.");
      manualUrlInput.focus();
      return;
    }
    window.open(safeUrl.href, "_blank", "noopener,noreferrer");
  });

  manualSearchButton.addEventListener("click", () => {
    const query = input.value.trim();
    if (!query) {
      showToast("Enter a song or artist in the main search box first.");
      input.focus();
      return;
    }
    const searchUrl = `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
    window.open(searchUrl, "_blank", "noopener,noreferrer");
  });

  manualUrlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      manualPlayButton.click();
    }
  });

  document.querySelectorAll("[data-query]").forEach((button) => {
    button.addEventListener("click", () => {
      const query = button.getAttribute("data-query") || "";
      input.value = query;
      if (apiBase) searchTracks(query);
      else showToast("Set your Render URL in config.js first.");
    });
  });

  async function fetchApi(path) {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      try {
        const body = await response.json();
        if (body && body.detail) message = String(body.detail);
      } catch (_) { /* Keep the HTTP error message. */ }
      throw new Error(message);
    }
    return response.json();
  }

  async function searchTracks(query) {
    setSearching(true);
    resultsSection.classList.remove("hidden");
    resultsTitle.textContent = `Results for “${query}”`;
    resultsMeta.textContent = "Searching…";
    resultsList.replaceChildren();
    try {
      const data = await fetchApi(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
      const tracks = (Array.isArray(data.items) ? data.items : []).filter((track) => track && track.videoId);
      resultsMeta.textContent = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`;
      if (!tracks.length) {
        resultsList.append(createMessage("No playable song results returned. Try a different search."));
        return;
      }
      tracks.forEach((track, index) => resultsList.append(createTrackRow(track, index + 1, false, tracks, index)));
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      resultsMeta.textContent = "Unavailable";
      resultsList.append(createMessage(`Could not fetch songs. ${error.message}`, true));
      manualFallback.open = true;
      manualNote.textContent = "Search failed. Open YouTube Music in a new tab, copy a track's URL, then paste it above. Manual playback still requires the Render stream endpoint to be reachable.";
      showToast("Search failed. Use the manual YouTube Music URL fallback below.");
    } finally {
      setSearching(false);
    }
  }

  async function loadRecommendations() {
    try {
      const data = await fetchApi("/api/recommendations");
      const sections = Array.isArray(data.sections) ? data.sections : [];
      const usable = sections
        .map((section) => ({ ...section, items: Array.isArray(section.items) ? section.items.filter((item) => item && item.videoId) : [] }))
        .filter((section) => section.items.length);
      if (!usable.length) {
        recommendationsMeta.textContent = "No feed data";
        return;
      }
      recommendationsGrid.replaceChildren();
      usable.slice(0, 6).forEach((section, index) => {
        const card = document.createElement("section");
        card.className = `api-section api-section-${(index % 4) + 1}`;
        const heading = document.createElement("div");
        heading.className = "api-section-heading";
        const title = document.createElement("h3");
        title.textContent = section.title || "Recommended tracks";
        const hint = document.createElement("span");
        hint.textContent = "TAP TO PLAY HERE";
        heading.append(title, hint);
        const list = document.createElement("div");
        list.className = "mini-track-list";
        section.items.slice(0, 8).forEach((item, itemIndex) => {
          list.append(createTrackRow(item, itemIndex + 1, true, section.items, itemIndex));
        });
        card.append(heading, list);
        recommendationsGrid.append(card);
      });
      recommendationsMeta.textContent = "From YouTube Music";
    } catch (error) {
      recommendationsMeta.textContent = "Feed unavailable";
      showToast("Recommendations couldn't load. Search can still be tested.");
    }
  }

  function createTrackRow(track, number, compact = false, collection = [track], indexInCollection = 0) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = compact ? "track-row compact-track" : "track-row";
    row.dataset.videoId = String(track.videoId || "");
    row.setAttribute("aria-label", `Play ${track.title || "track"}`);

    const count = document.createElement("span");
    count.className = "track-number";
    count.textContent = String(number).padStart(2, "0");

    const art = document.createElement("span");
    art.className = "track-art";
    const thumbnail = safeImageUrl(track.thumbnail || track.thumbnailUrl || (Array.isArray(track.thumbnails) && track.thumbnails.length ? track.thumbnails[track.thumbnails.length - 1].url : ""));
    if (thumbnail) {
      const image = document.createElement("img");
      image.src = thumbnail;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => { image.remove(); art.classList.add("no-art"); art.textContent = "♪"; };
      art.append(image);
    } else {
      art.classList.add("no-art");
      art.textContent = "♪";
    }

    const details = document.createElement("span");
    details.className = "track-details";
    const title = document.createElement("strong");
    title.textContent = track.title || "Untitled track";
    const subtitle = document.createElement("small");
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => typeof artist === "string" ? artist : artist && artist.name).filter(Boolean).join(", ")
      : (track.artist || "");
    const album = track.album && (typeof track.album === "string" ? track.album : track.album.name);
    subtitle.textContent = [artists, album, track.duration].filter(Boolean).join(" · ") || "YouTube Music result";
    details.append(title, subtitle);

    const action = document.createElement("span");
    action.className = "track-action";
    action.setAttribute("aria-hidden", "true");
    action.textContent = "▶";
    row.append(count, art, details, action);

    row.addEventListener("click", () => {
      const queue = Array.isArray(collection) && collection.length ? collection : [track];
      const safeIndex = Math.max(0, Math.min(indexInCollection, queue.length - 1));
      startTrack(track, queue, safeIndex);
    });
    return row;
  }

  function startTrack(track, queue = [track], index = 0) {
    if (!apiBase) {
      showToast("Set your Render URL in config.js first.");
      return;
    }
    if (!track || !/^[A-Za-z0-9_-]{11}$/.test(String(track.videoId || ""))) {
      showToast("This result doesn't have a playable video ID.");
      return;
    }

    currentTrack = track;
    playbackQueue = queue;
    queueIndex = index;
    sourceFailureShown = false;
    updateCurrentTrackUI(track);
    updateQueueButtons();
    highlightCurrentRows();

    // Set src and call play synchronously in the user's tap handler. This gives
    // Safari the best chance of honoring its media user-gesture requirement.
    audio.pause();
    setPlayerStatus("CONNECTING…");
    audio.src = `${apiBase}/api/stream/${encodeURIComponent(track.videoId)}`;
    audio.load();
    const playRequest = audio.play();
    if (playRequest && typeof playRequest.catch === "function") {
      playRequest.catch((error) => {
        if (error && error.name === "NotAllowedError") {
          setPlayerStatus("TAP PLAY");
          showToast("Safari needs another tap. Press Play in the player below.");
        } else if (error && error.name !== "AbortError") {
          setPlayerStatus("STREAM ERROR");
          if (!sourceFailureShown) {
            sourceFailureShown = true;
            showToast("Couldn't start this stream. Try again or choose another track.");
          }
        }
      });
    }
  }

  function updateCurrentTrackUI(track) {
    playerTitle.textContent = track.title || "Untitled track";
    const artists = Array.isArray(track.artists)
      ? track.artists.map((artist) => typeof artist === "string" ? artist : artist && artist.name).filter(Boolean).join(", ")
      : (track.artist || "");
    const album = track.album && (typeof track.album === "string" ? track.album : track.album.name);
    playerArtist.textContent = [artists, album].filter(Boolean).join(" · ") || "YouTube Music result";
    playerArt.replaceChildren();
    playerArt.classList.remove("no-art");
    const artwork = safeImageUrl(track.thumbnail || track.thumbnailUrl || "");
    if (artwork) {
      const image = document.createElement("img");
      image.src = artwork;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => { image.remove(); playerArt.classList.add("no-art"); playerArt.textContent = "♪"; };
      playerArt.append(image);
    } else {
      playerArt.classList.add("no-art");
      playerArt.textContent = "♪";
    }
    seekbar.value = "0";
    seekbar.disabled = false;
    currentTimeLabel.textContent = "0:00";
    durationLabel.textContent = track.duration || "0:00";
    playPauseButton.disabled = false;
    updateMediaSession(track);
  }

  function updateMediaSession(track) {
    if (!("mediaSession" in navigator)) return;
    try {
      if ("MediaMetadata" in window) {
        const image = safeImageUrl(track.thumbnail || "");
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || "Afterhours",
          artist: Array.isArray(track.artists) ? track.artists.map((a) => typeof a === "string" ? a : a && a.name).filter(Boolean).join(", ") : (track.artist || ""),
          album: track.album && (typeof track.album === "string" ? track.album : track.album.name) || "Afterhours",
          artwork: image ? [{ src: image, sizes: "512x512" }] : []
        });
      }
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("previoustrack", playPrevious);
      navigator.mediaSession.setActionHandler("nexttrack", playNext);
      navigator.mediaSession.setActionHandler("seekbackward", (details) => { audio.currentTime = Math.max(0, audio.currentTime - (details.seekOffset || 10)); });
      navigator.mediaSession.setActionHandler("seekforward", (details) => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + (details.seekOffset || 10)); });
      navigator.mediaSession.setActionHandler("seekto", (details) => { if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime; });
    } catch (_) { /* Media Session is optional and browser-dependent. */ }
  }

  function setPlayerStatus(message) {
    playerStatus.textContent = message;
    statusLed.classList.toggle("status-led-active", ["PLAYING", "BUFFERING"].includes(message));
  }

  function setPlayButton(isPlaying) {
    playPauseButton.textContent = isPlaying ? "Ⅱ" : "▶";
    playPauseButton.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"; } catch (_) { /* optional */ }
    }
  }

  function updateQueueButtons() {
    previousButton.disabled = queueIndex <= 0;
    nextButton.disabled = queueIndex < 0 || queueIndex >= playbackQueue.length - 1;
  }

  function playPrevious() {
    if (queueIndex > 0) startTrack(playbackQueue[queueIndex - 1], playbackQueue, queueIndex - 1);
  }

  function playNext() {
    if (queueIndex >= 0 && queueIndex < playbackQueue.length - 1) startTrack(playbackQueue[queueIndex + 1], playbackQueue, queueIndex + 1);
  }

  function highlightCurrentRows() {
    document.querySelectorAll(".track-row[data-video-id]").forEach((row) => {
      const active = row.dataset.videoId === String(currentTrack && currentTrack.videoId || "");
      row.classList.toggle("is-playing", active);
      const action = row.querySelector(".track-action");
      if (action) action.textContent = active ? "♫" : "▶";
    });
  }

  playPauseButton.addEventListener("click", () => {
    if (!currentTrack) {
      showToast("Search for a song and tap a result first.");
      return;
    }
    if (audio.paused) {
      audio.play().catch(() => showToast("Safari couldn't resume this stream. Try selecting the track again."));
    } else {
      audio.pause();
    }
  });
  previousButton.addEventListener("click", playPrevious);
  nextButton.addEventListener("click", playNext);

  audio.addEventListener("playing", () => {
    setPlayButton(true);
    setPlayerStatus("PLAYING");
  });
  audio.addEventListener("pause", () => {
    setPlayButton(false);
    if (currentTrack && !audio.ended && playerStatus.textContent !== "STREAM ERROR") setPlayerStatus("PAUSED");
  });
  audio.addEventListener("waiting", () => setPlayerStatus("BUFFERING"));
  audio.addEventListener("stalled", () => setPlayerStatus("BUFFERING"));
  audio.addEventListener("canplay", () => {
    if (audio.paused) setPlayerStatus("READY");
  });
  audio.addEventListener("loadedmetadata", updateTimeUI);
  audio.addEventListener("durationchange", updateTimeUI);
  audio.addEventListener("timeupdate", updateTimeUI);
  audio.addEventListener("ended", () => {
    if (queueIndex >= 0 && queueIndex < playbackQueue.length - 1) {
      playNext();
    } else {
      setPlayButton(false);
      setPlayerStatus("ENDED");
    }
  });
  audio.addEventListener("error", () => {
    if (!currentTrack || sourceFailureShown) return;
    sourceFailureShown = true;
    setPlayerStatus("STREAM ERROR");
    manualFallback.open = true;
    manualNote.textContent = "The stream attempt failed. You can retry with another URL, or open the pasted link in YouTube Music. If Render is down, the custom player cannot resolve the link by itself.";
    showToast("Stream failed. Try the manual fallback or open the link in YouTube Music.");
  });
  seekbar.addEventListener("input", () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (Number(seekbar.value) / Number(seekbar.max)) * audio.duration;
      updateTimeUI();
    }
  });

  function updateTimeUI() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    currentTimeLabel.textContent = formatTime(current);
    if (duration > 0) {
      seekbar.value = String(Math.round((current / duration) * Number(seekbar.max)));
      durationLabel.textContent = formatTime(duration);
      if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
        try { navigator.mediaSession.setPositionState({ duration, playbackRate: audio.playbackRate || 1, position: Math.min(current, duration) }); } catch (_) { /* optional */ }
      }
    }
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function parseAllowedYouTubeUrl(rawValue) {
    try {
      const url = new URL(String(rawValue || "").trim());
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      const allowedHosts = new Set([
        "music.youtube.com", "youtube.com", "www.youtube.com", "m.youtube.com",
        "youtu.be", "www.youtu.be"
      ]);
      return allowedHosts.has(host) ? url : null;
    } catch (_) {
      return null;
    }
  }

  function parseYouTubeTrackUrl(rawValue) {
    const url = parseAllowedYouTubeUrl(rawValue);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    let videoId = "";
    if (host === "youtu.be" || host === "www.youtu.be") {
      videoId = url.pathname.split("/").filter(Boolean)[0] || "";
    } else {
      videoId = url.searchParams.get("v") || "";
      if (!videoId) {
        const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
        if (match) videoId = match[1];
      }
    }
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return { videoId, url: url.href };
  }

  function safeImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : "";
    } catch (_) { return ""; }
  }

  function createMessage(message, warning = false) {
    const element = document.createElement("div");
    element.className = warning ? "empty-state warning-state" : "empty-state";
    const text = document.createElement("p");
    text.textContent = message;
    element.append(text);
    if (warning) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = "Retry search";
      button.addEventListener("click", () => searchTracks(input.value.trim()));
      element.append(button);
    }
    return element;
  }

  function setSearching(isSearching) {
    searchButton.disabled = isSearching;
    searchButton.innerHTML = isSearching ? 'Searching <span class="spinner" aria-hidden="true"></span>' : 'Search <span aria-hidden="true">⌕</span>';
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 4200);
  }
})();
