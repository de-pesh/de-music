(() => {
  "use strict";

  const config = window.AFTERHOURS_CONFIG || {};
  const apiBase = String(config.API_BASE_URL || "").trim().replace(/\/$/, "");
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const searchButton = document.getElementById("search-button");
  const searchNote = document.getElementById("search-note");
  const resultsSection = document.getElementById("results-section");
  const resultsTitle = document.getElementById("results-title");
  const resultsMeta = document.getElementById("results-meta");
  const resultsList = document.getElementById("results-list");
  const recommendationsGrid = document.getElementById("recommendations-grid");
  const recommendationsMeta = document.getElementById("recommendations-meta");
  const connectionCard = document.getElementById("connection-card");
  const connectionStatus = document.getElementById("connection-status");
  const toast = document.getElementById("toast");
  let toastTimer;

  if (apiBase) {
    connectionCard.classList.add("connected");
    connectionStatus.textContent = "API CONFIGURED";
    searchNote.textContent = "Search results appear here. Choose a track to open it in YouTube Music.";
    recommendationsMeta.textContent = "From YouTube Music";
    loadRecommendations();
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
      openYtmSearch(query);
      return;
    }
    searchTracks(query);
  });

  document.querySelectorAll("[data-query]").forEach((button) => {
    button.addEventListener("click", () => {
      const query = button.getAttribute("data-query") || "";
      input.value = query;
      if (apiBase) searchTracks(query);
      else openYtmSearch(query);
    });
  });

  function openYtmSearch(query) {
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function fetchApi(path) {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { "Accept": "application/json" },
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
      const tracks = Array.isArray(data.items) ? data.items : [];
      resultsMeta.textContent = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`;
      if (!tracks.length) {
        resultsList.append(createMessage("No song results were returned. Try a different search."));
        return;
      }
      tracks.forEach((track, index) => resultsList.append(createTrackRow(track, index + 1)));
      resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      resultsMeta.textContent = "Unavailable";
      resultsList.append(createMessage(`Could not fetch results from the API. ${error.message}. You can still search directly on YouTube Music.`, true));
      showToast("API request failed; direct YouTube Music search is still available.");
    } finally {
      setSearching(false);
    }
  }

  async function loadRecommendations() {
    try {
      const data = await fetchApi("/api/recommendations");
      const sections = Array.isArray(data.sections) ? data.sections : [];
      const usable = sections.filter((section) => Array.isArray(section.items) && section.items.length);
      if (!usable.length) {
        recommendationsMeta.textContent = "Curated searches";
        return;
      }
      recommendationsGrid.replaceChildren();
      usable.slice(0, 6).forEach((section, index) => {
        const card = document.createElement("section");
        card.className = `api-section api-section-${(index % 4) + 1}`;
        const heading = document.createElement("div");
        heading.className = "api-section-heading";
        const title = document.createElement("h3");
        title.textContent = section.title || "Recommended for you";
        const hint = document.createElement("span");
        hint.textContent = "FROM YOUTUBE MUSIC";
        heading.append(title, hint);
        const list = document.createElement("div");
        list.className = "mini-track-list";
        section.items.slice(0, 6).forEach((item, itemIndex) => list.append(createTrackRow(item, itemIndex + 1, true)));
        card.append(heading, list);
        recommendationsGrid.append(card);
      });
      recommendationsMeta.textContent = "Home feed";
      showToast("YouTube Music discovery feed loaded.");
    } catch (error) {
      recommendationsMeta.textContent = "Curated searches";
      showToast("Recommendations could not load. Check the API URL and backend logs.");
    }
  }

  function createTrackRow(track, number, compact = false) {
    const row = document.createElement("a");
    row.className = compact ? "track-row compact-track" : "track-row";
    row.href = safeMusicUrl(track.url || track.musicUrl || (track.videoId ? `https://music.youtube.com/watch?v=${encodeURIComponent(track.videoId)}` : "https://music.youtube.com/"));
    row.target = "_blank";
    row.rel = "noopener noreferrer";

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
    const artists = Array.isArray(track.artists) ? track.artists.map((artist) => typeof artist === "string" ? artist : artist && artist.name).filter(Boolean).join(", ") : (track.artist || "");
    const album = track.album && (typeof track.album === "string" ? track.album : track.album.name);
    subtitle.textContent = [artists, album, track.duration].filter(Boolean).join(" · ") || "Open in YouTube Music";
    details.append(title, subtitle);

    const action = document.createElement("span");
    action.className = "track-action";
    action.setAttribute("aria-hidden", "true");
    action.textContent = "↗";
    row.append(count, art, details, action);
    return row;
  }

  function safeMusicUrl(value) {
    try {
      const url = new URL(value, "https://music.youtube.com/");
      if (url.protocol === "https:" && ["music.youtube.com", "www.youtube.com", "youtube.com"].includes(url.hostname)) return url.href;
    } catch (_) { /* Use the safe fallback. */ }
    return "https://music.youtube.com/";
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
      button.textContent = "Open YouTube Music search ↗";
      button.addEventListener("click", () => openYtmSearch(input.value.trim()));
      element.append(button);
    }
    return element;
  }

  function setSearching(isSearching) {
    searchButton.disabled = isSearching;
    searchButton.innerHTML = isSearching ? 'Searching <span class="spinner" aria-hidden="true"></span>' : 'Search <span aria-hidden="true">↗</span>';
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 3800);
  }
})();
