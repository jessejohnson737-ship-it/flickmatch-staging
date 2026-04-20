import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { tmdb } from "./lib/api/tmdbClient.js";

function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1024 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}

const GENRES = {
  action: 28, adventure: 12, animation: 16, comedy: 35,
  crime: 80, drama: 18, fantasy: 14, horror: 27,
  romance: 10749, scifi: 878, thriller: 53, mystery: 9648, family: 10751,
};

const GENRE_NAMES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 18: "Drama", 14: "Fantasy", 27: "Horror",
  10749: "Romance", 878: "Sci-Fi", 53: "Thriller", 9648: "Mystery",
  10751: "Family", 36: "History", 10752: "War", 37: "Western",
  99: "Documentary", 10402: "Music", 10770: "TV Movie",
};

// Derive mood-relevant tags for a movie given user answers
function getMoodTags(movie, answers) {
  const tags = [];

  // Genre tags from movie data
  const genreLabels = (movie.genre_ids || [])
    .map(id => GENRE_NAMES[id])
    .filter(Boolean)
    .slice(0, 2);
  tags.push(...genreLabels);

  // Contextual mood tags based on answers + movie signals
  const rating = movie.vote_average || 0;
  const votes = movie.vote_count || 0;
  const year = parseInt(movie.release_date?.slice(0, 4) || "0");
  const now = new Date().getFullYear();

  if (rating >= 8.0) tags.push("Masterpiece");
  else if (rating >= 7.5 && votes > 5000) tags.push("Crowd favourite");

  if (votes < 1500 && rating >= 7.2) tags.push("Hidden gem");
  if (year >= now - 2) tags.push("Recent");
  if (year <= 2000 && rating >= 7.5) tags.push("Classic");

  if (answers.company === "partner") tags.push("Date night");
  if (answers.company === "friends") tags.push("Group watch");
  if (answers.company === "family") tags.push("Family-friendly");

  if (answers.intensity === "dark" && rating >= 7.5) tags.push("Critically acclaimed");
  if (answers.intent === "think") tags.push("Thought-provoking");
  if (answers.intent === "feel") tags.push("Emotional");
  if (answers.intent === "laugh") tags.push("Feel-good");
  if (answers.intent === "escape") tags.push("Immersive");

  if (answers.time === "short" && (movie.runtime || 120) < 95) tags.push("Quick watch");
  if (answers.time === "long") tags.push("Epic");

  // Deduplicate and cap
  return [...new Set(tags)].slice(0, 5);
}

// Generate a personalised "why watch this" sentence from answers + movie data
function getWhyWatch(movie, answers, index) {
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : null;
  const year = movie.release_date?.slice(0, 4) || null;
  const votes = movie.vote_count || 0;

  const intentPhrases = {
    escape: ["perfect for switching off completely", "exactly the kind of escape you need", "puts you somewhere else entirely"],
    feel: ["will hit you somewhere real", "earned its emotional weight", "the kind of film you sit with after"],
    laugh: ["genuinely funny without trying too hard", "easy laughs, no effort required", "hard not to smile through this one"],
    think: ["rewards the attention you put in", "keeps you guessing until the end", "the kind of film you discuss after"],
  };
  const familiarPhrases = {
    hidden: "Not many people have seen this one — which makes it better.",
    classic: `Rated ${rating} by ${(votes/1000).toFixed(0)}K people — it earned that.`,
    new: `From ${year} — fresh enough to feel current.`,
    surprise: "You asked to be surprised. This is the pick.",
  };
  const companyPhrases = {
    solo: "A good solo watch.",
    partner: "Works well for two.",
    friends: "Good group energy.",
    family: "Safe for the whole room.",
  };

  const intentLine = (intentPhrases[answers.intent] || ["a solid pick for tonight"])[index % 3];
  const familiarLine = familiarPhrases[answers.familiar] || "";
  const companyLine = companyPhrases[answers.company] || "";

  return [familiarLine, `It's ${intentLine}.`, companyLine].filter(Boolean).join(" ");
}

// ─── Viewer mode profiles ─────────────────────────────────────────────────────
// Controls era, vote count floors, sort preference
const VIEWER_MODES = {
  casual: {
    label: "Casual",
    emoji: "🍿",
    desc: "Popular movies from the 90s till now",
    yearFrom: 1990,
    voteCountMin: 1500,       // needs real mainstream consensus
    voteCountMax: null,
    ratingMin: 6.5,
    sortBy: "popularity.desc",
    allowOldClassics: false,
  },
  buff: {
    label: "Movie buff",
    emoji: "🎬",
    desc: "All eras, rating-weighted, quality-first",
    yearFrom: 1970,
    voteCountMin: 800,
    voteCountMax: null,
    ratingMin: 7.0,
    sortBy: "vote_average.desc",
    allowOldClassics: true,
  },
  cineville: {
    label: "Cineville",
    emoji: "🎭",
    desc: "Art house, world cinema, hidden gems",
    yearFrom: null,           // no era restriction
    voteCountMin: 200,
    voteCountMax: 3000,       // specifically avoids blockbusters
    ratingMin: 7.2,
    sortBy: "vote_average.desc",
    allowOldClassics: true,
  },
};

// ─── Questions (reordered psychologically) ────────────────────────────────────
// 1. Intent first — activates emotional state immediately
// 2. Familiarity — frames the whole search early
// 3. Company — social context refines intent
// 4. Intensity — content filter
// 5. Time — practical last
const CORE_QUESTIONS = [
  {
    id: "intent",
    text: "What do you want from tonight?",
    options: [
      { label: "Escape everything", value: "escape", emoji: "✈️" },
      { label: "Feel something real", value: "feel", emoji: "🌊" },
      { label: "Just laugh", value: "laugh", emoji: "😂" },
      { label: "Get my mind going", value: "think", emoji: "🧠" },
    ],
  },
  {
    id: "familiar",
    text: "Discovery or comfort?",
    options: [
      { label: "Show me something new", value: "new", emoji: "🔭" },
      { label: "A hidden gem", value: "hidden", emoji: "💎" },
      { label: "Something proven great", value: "classic", emoji: "🏆" },
      { label: "Surprise me", value: "surprise", emoji: "🎲" },
    ],
  },
  {
    id: "company",
    text: "Who are you watching with?",
    options: [
      { label: "Solo", value: "solo", emoji: "🌙" },
      { label: "Partner", value: "partner", emoji: "🫂" },
      { label: "Friends", value: "friends", emoji: "🍕" },
      { label: "Family", value: "family", emoji: "🏠" },
    ],
  },
  {
    id: "intensity",
    text: "How intense can it get?",
    options: [
      { label: "Keep it light", value: "light", emoji: "🌸" },
      { label: "Some tension is fine", value: "medium", emoji: "🌗" },
      { label: "Hit me hard", value: "dark", emoji: "🌑" },
    ],
  },
  {
    id: "time",
    text: "How long do you have?",
    options: [
      { label: "Under 90 min", value: "short", emoji: "⏱️" },
      { label: "A full movie", value: "normal", emoji: "🎬" },
      { label: "Whatever it takes", value: "long", emoji: "🌃" },
    ],
  },
];

// ─── Adaptive follow-ups ──────────────────────────────────────────────────────
function getAdaptiveQuestions(answers) {
  const qs = [];

  if (answers.intent === "escape") {
    qs.push({
      id: "escape_type",
      text: "What kind of escape?",
      options: [
        { label: "Other worlds", value: "fantasy", emoji: "🌍" },
        { label: "Action & speed", value: "action", emoji: "💥" },
        { label: "Future tech", value: "scifi", emoji: "🚀" },
        { label: "Epic adventure", value: "adventure", emoji: "🗺️" },
      ],
    });
  }

  if (answers.intent === "feel") {
    qs.push({
      id: "feel_type",
      text: "What kind of feeling?",
      options: [
        { label: "Cry it out", value: "cry", emoji: "😢" },
        { label: "Inspired", value: "inspired", emoji: "✨" },
        { label: "Unsettled", value: "unsettled", emoji: "😶" },
        { label: "Warm inside", value: "warm", emoji: "🌅" },
      ],
    });
  }

  if (answers.intent === "think") {
    qs.push({
      id: "think_type",
      text: "What kind of challenge?",
      options: [
        { label: "Mind-bending plot", value: "mindbend", emoji: "🌀" },
        { label: "Psychological", value: "psych", emoji: "🧠" },
        { label: "Crime to solve", value: "crime", emoji: "🔍" },
        { label: "Slow burn tension", value: "slowburn", emoji: "🕯️" },
      ],
    });
  }

  if (answers.intent === "laugh") {
    qs.push({
      id: "laugh_type",
      text: "What kind of funny?",
      options: [
        { label: "Stupid & loud", value: "stupid", emoji: "🤡" },
        { label: "Dry wit", value: "dry", emoji: "🧂" },
        { label: "Awkward cringe", value: "cringe", emoji: "😬" },
        { label: "Heartfelt comedy", value: "warm", emoji: "🌻" },
      ],
    });
  }

  if (answers.intensity === "dark") {
    qs.push({
      id: "dark_type",
      text: "How dark are we talking?",
      options: [
        { label: "Tense thriller", value: "thriller", emoji: "😰" },
        { label: "Disturbing drama", value: "drama", emoji: "🖤" },
        { label: "Actual horror", value: "horror", emoji: "👁️" },
        { label: "Bleak & beautiful", value: "arthouse", emoji: "🎭" },
      ],
    });
  }

  if (answers.familiar === "new") {
    qs.push({
      id: "new_origin",
      text: "Any preference on where it's from?",
      options: [
        { label: "Anywhere", value: "any", emoji: "🌐" },
        { label: "European cinema", value: "europe", emoji: "🗼" },
        { label: "Asian cinema", value: "asia", emoji: "🏮" },
        { label: "American indie", value: "indie", emoji: "🎸" },
      ],
    });
  }

  return qs.slice(0, 2);
}

/**
 * Single `with_genres` for TMDB discover. Pipes (`|`) = OR, commas = AND.
 * We avoid `pool[attempt % n]` — alternating one genre per request sent half the "load more"
 * traffic into the wrong mood (e.g. Crime-only for "just laugh"). OR keeps every query inside
 * the same intent envelope; laugh is special-cased so comedy always anchors the tone.
 */
function discoverWithGenresValue(answers, pool) {
  if (!pool?.length) return null;
  if (answers.familiar === "surprise") return String(pool[0]);

  if (answers.dark_type === "horror") return String(GENRES.horror);
  if (answers.dark_type === "thriller") return [GENRES.thriller, GENRES.crime].join("|");
  if (answers.dark_type === "drama" || answers.dark_type === "arthouse") return String(GENRES.drama);

  if (answers.intent === "laugh") {
    if (answers.laugh_type === "warm") return [GENRES.comedy, GENRES.family].join("|");
    return String(GENRES.comedy);
  }

  if (answers.company === "family" || answers.intent === "feel" || answers.intent === "escape" || answers.intent === "think") {
    return pool.map(String).join("|");
  }

  return pool.length === 1 ? String(pool[0]) : pool.map(String).join("|");
}

// ─── TMDB param builder ───────────────────────────────────────────────────────
// Optional `stream`: when set, restricts discover to titles available on those providers in `watchRegion` (TMDB + JustWatch).
// Optional `tuning`: sidebar refinements — OR-extra genres on `with_genres`, OR-keywords on `with_keywords` (pipe-separated).
function buildParams(answers, attempt = 0, viewerMode = "casual", stream = null, tuning = null) {
  const mode = VIEWER_MODES[viewerMode] || VIEWER_MODES.casual;

  const p = new URLSearchParams({
    include_adult: false,
    language: "en-US",
    "vote_count.gte": mode.voteCountMin,
    "vote_average.gte": mode.ratingMin,
  });

  // Era restriction from viewer mode
  if (mode.yearFrom) {
    p.set("primary_release_date.gte", `${mode.yearFrom}-01-01`);
  }
  if (mode.voteCountMax) {
    p.set("vote_count.lte", mode.voteCountMax);
  }

  if (answers.time === "short") p.set("with_runtime.lte", 95);
  else if (answers.time === "normal") { p.set("with_runtime.gte", 80); p.set("with_runtime.lte", 140); }
  else if (answers.time === "long") p.set("with_runtime.gte", 100);

  let pool = [];
  if (answers.company === "family") {
    pool = [GENRES.animation, GENRES.family, GENRES.adventure, GENRES.comedy];
  } else if (answers.intent === "escape") {
    const sub = answers.escape_type;
    if (sub === "fantasy") pool = [GENRES.fantasy, GENRES.adventure];
    else if (sub === "action") pool = [GENRES.action, GENRES.adventure];
    else if (sub === "scifi") pool = [GENRES.scifi, GENRES.adventure];
    else if (sub === "adventure") pool = [GENRES.adventure, GENRES.action];
    else pool = [GENRES.adventure, GENRES.scifi, GENRES.action, GENRES.fantasy];
  } else if (answers.intent === "feel") {
    const sub = answers.feel_type;
    if (sub === "cry") pool = [GENRES.drama, GENRES.romance];
    else if (sub === "inspired") pool = [GENRES.drama, GENRES.adventure];
    else if (sub === "unsettled") pool = [GENRES.mystery, GENRES.thriller, GENRES.drama];
    else if (sub === "warm") pool = [GENRES.romance, GENRES.drama, GENRES.family];
    else pool = [GENRES.drama, GENRES.mystery, GENRES.romance];
  } else if (answers.intent === "laugh") {
    const sub = answers.laugh_type;
    if (sub === "stupid") pool = [GENRES.comedy];
    else if (sub === "dry") pool = [GENRES.comedy, GENRES.crime];
    else if (sub === "cringe") pool = [GENRES.comedy, GENRES.drama];
    else if (sub === "warm") pool = [GENRES.comedy, GENRES.romance, GENRES.family];
    else pool = [GENRES.comedy, GENRES.animation];
  } else if (answers.intent === "think") {
    const sub = answers.think_type;
    if (sub === "mindbend") pool = [GENRES.scifi, GENRES.mystery, GENRES.thriller];
    else if (sub === "psych") pool = [GENRES.thriller, GENRES.mystery];
    else if (sub === "crime") pool = [GENRES.crime, GENRES.thriller, GENRES.mystery];
    else if (sub === "slowburn") pool = [GENRES.thriller, GENRES.drama, GENRES.mystery];
    else pool = [GENRES.thriller, GENRES.crime, GENRES.mystery, GENRES.scifi];
  }

  if (answers.dark_type === "horror") pool = [GENRES.horror];
  else if (answers.dark_type === "thriller") pool = [GENRES.thriller, GENRES.crime];
  else if (answers.dark_type === "drama") pool = [GENRES.drama];
  else if (answers.dark_type === "arthouse") pool = [GENRES.drama];

  // Surprise: randomize genre pool
  if (answers.familiar === "surprise") {
    const all = Object.values(GENRES);
    pool = [all[Math.floor(Math.random() * all.length)]];
  }

  const genreParam = discoverWithGenresValue(answers, pool);
  if (genreParam) p.set("with_genres", genreParam);

  const extraGenreIds = (tuning?.extraGenreIds || []).filter(n => Number.isFinite(n));
  if (extraGenreIds.length) {
    const existing = p.get("with_genres");
    const merged = new Set([...(existing ? existing.split("|") : []), ...extraGenreIds.map(String)]);
    p.set("with_genres", [...merged].join("|"));
  }

  const keywordIds = (tuning?.keywordIds || []).filter(n => Number.isFinite(n));
  if (keywordIds.length) {
    p.set("with_keywords", [...new Set(keywordIds.map(String))].join("|"));
  }

  if (answers.intensity === "dark") p.set("vote_average.gte", 7.3);
  else if (answers.intensity === "light") p.set("vote_average.gte", 6.8);
  else p.set("vote_average.gte", 7.0);

  // Dry wit: nudge toward sharper writing without opening non-comedy genres
  if (answers.intent === "laugh" && answers.laugh_type === "dry") {
    const floor = Number.parseFloat(p.get("vote_average.gte") || "7");
    if (!Number.isNaN(floor)) p.set("vote_average.gte", String(Math.max(floor, 7.05)));
  }

  if (answers.familiar === "hidden") {
    // Hidden gem: tighten vote count but respect mode's floor
    p.set("vote_count.gte", Math.max(mode.voteCountMin, 200));
    p.set("vote_count.lte", viewerMode === "cineville" ? 1500 : 2500);
    p.set("vote_average.gte", Math.max(mode.ratingMin, 7.2));
    p.set("sort_by", "vote_average.desc");
  } else if (answers.familiar === "classic") {
    // Proven great: high vote count, high rating — mode era still applies
    p.set("vote_count.gte", Math.max(mode.voteCountMin, viewerMode === "casual" ? 3000 : 5000));
    p.set("vote_average.gte", Math.max(mode.ratingMin, 7.5));
    p.set("sort_by", "vote_average.desc");
    if (mode.voteCountMax) p.delete("vote_count.lte"); // classics can be blockbusters
  } else if (answers.familiar === "surprise") {
    p.set("vote_count.gte", Math.max(mode.voteCountMin, 800));
    p.set("vote_average.gte", Math.max(mode.ratingMin, 6.8));
    p.set("sort_by", "vote_average.desc");
  } else {
    // "New" — recent releases, respect mode's year floor but add recency
    const y = new Date().getFullYear();
    const recentYear = Math.max(mode.yearFrom || 1990, y - 3);
    p.set("primary_release_date.gte", `${recentYear}-01-01`);
    p.set("vote_count.gte", Math.max(mode.voteCountMin, 400));
    p.set("sort_by", viewerMode === "casual" ? "popularity.desc" : mode.sortBy);
  }

  // TMDB expects a single original language code here. For region “vibes” we pick
  // a representative language per attempt rather than passing an invalid list.
  const EURO_LANGS = ["fr", "de", "it", "es", "nl", "sv", "da", "no"];
  const ASIA_LANGS = ["ja", "ko", "zh"];
  if (answers.new_origin === "europe") p.set("with_original_language", EURO_LANGS[attempt % EURO_LANGS.length]);
  else if (answers.new_origin === "asia") p.set("with_original_language", ASIA_LANGS[attempt % ASIA_LANGS.length]);
  else if (answers.new_origin === "indie") { p.set("with_original_language", "en"); p.set("vote_count.lte", 800); }

  if (stream?.watchRegion && stream?.providerPipe) {
    p.set("watch_region", stream.watchRegion);
    p.set("with_watch_providers", stream.providerPipe);
    p.set("with_watch_monetization_types", "flatrate|rent");
  }

  p.set("page", Math.floor(Math.random() * 6) + 1);
  return p.toString();
}

// Build params for the live preview — uses only answers available so far,
// always returns something so the panel never goes empty.
function buildPreviewParams(answers) {
  const p = new URLSearchParams({
    include_adult: false,
    language: "en-US",
    "vote_count.gte": 500,
    "vote_average.gte": 6.8,
    sort_by: "popularity.desc",
    page: Math.floor(Math.random() * 4) + 1,
  });

  // Genre from intent (most informative signal we have early)
  let genreId = null;
  if (answers.intent === "escape") genreId = GENRES.adventure;
  else if (answers.intent === "feel") genreId = GENRES.drama;
  else if (answers.intent === "laugh") genreId = GENRES.comedy;
  else if (answers.intent === "think") genreId = GENRES.thriller;

  // Refine if we also know company
  if (answers.company === "family") genreId = GENRES.animation;
  if (answers.company === "partner" && answers.intent === "feel") genreId = GENRES.romance;

  // Refine intensity if known
  if (answers.intensity === "dark") {
    p.set("vote_average.gte", 7.2);
    p.set("sort_by", "vote_average.desc");
  }

  // Familiarity if known
  if (answers.familiar === "hidden") {
    p.set("vote_count.gte", 300);
    p.set("vote_count.lte", 2500);
    p.set("sort_by", "vote_average.desc");
  } else if (answers.familiar === "classic") {
    p.set("vote_count.gte", 5000);
    p.set("vote_average.gte", 7.5);
  } else if (answers.familiar === "new") {
    const y = new Date().getFullYear();
    p.set("primary_release_date.gte", `${y - 3}-01-01`);
  }

  if (genreId) p.set("with_genres", genreId);
  return p.toString();
}

async function fetchPreviewMovies(answers) {
  const qs = buildPreviewParams(answers);
  const data = await tmdb.discoverMovie(qs);
  return (data.results || []).filter(m => m.poster_path).slice(0, 12);
}

function providerPipeFromStreamDefs(activeDefs) {
  const ids = new Set();
  for (const d of activeDefs) for (const id of d.ids) ids.add(id);
  return [...ids].join("|");
}

function normalizeTuning(tuning) {
  const keywordIds = [...new Set((tuning?.keywordIds || []).filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const extraGenreIds = [...new Set((tuning?.extraGenreIds || []).filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  return { keywordIds, extraGenreIds };
}

/**
 * Full discover pass for the results sidebar: quiz answers + optional streaming (NL/US verified)
 * + optional keyword / genre OR-refinements. When nothing is tuned, delegates to `fetchFinalMovies`.
 */
async function fetchResultsWithTuning(answers, viewerMode, opts = {}) {
  const streamDefs = opts.streamDefs?.length ? opts.streamDefs : null;
  const tuning = normalizeTuning({ keywordIds: opts.keywordIds, extraGenreIds: opts.extraGenreIds });
  const hasStream = !!streamDefs?.length;
  const hasTuning = tuning.keywordIds.length > 0 || tuning.extraGenreIds.length > 0;
  if (!hasStream && !hasTuning) return fetchFinalMovies(answers, viewerMode);

  const providerPipe = hasStream ? providerPipeFromStreamDefs(streamDefs) : "";
  const requiredIds = hasStream ? [...new Set(streamDefs.flatMap(d => d.ids))] : [];
  const results = [];
  const seenIds = new Set();

  const pickFromDiscover = async (qsBase, i, region) => {
    const params = new URLSearchParams(qsBase);
    const salt = region ? i * 4 + results.length + region.charCodeAt(0) : i * 3 + results.length;
    params.set("page", String(salt % 20 + 1));
    const data = await tmdb.discoverMovie(params.toString());
    const pool = (data.results || []).filter(m => !seenIds.has(m.id) && m.poster_path).slice(0, 14);
    if (pool.length === 0) return null;
    const candidates = pool.slice(0, 10);
    if (requiredIds.length) {
      const flags = await Promise.all(candidates.map(m => movieHasAnyWatchProvider(m.id, requiredIds)));
      return candidates.find((m, idx) => flags[idx]) || null;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  };

  if (hasStream) {
    const regions = ["NL", "US"];
    for (const region of regions) {
      for (let i = 0; i < 14 && results.length < 6; i++) {
        const qsBase = buildParams(answers, i, viewerMode, { watchRegion: region, providerPipe }, tuning);
        try {
          const pick = await pickFromDiscover(qsBase, i, region);
          if (pick) {
            seenIds.add(pick.id);
            results.push(pick);
          }
        } catch {
          // continue
        }
      }
      if (results.length >= 6) break;
    }
  } else {
    for (let i = 0; i < 6; i++) {
      const qs = buildParams(answers, i, viewerMode, null, tuning);
      try {
        const data = await tmdb.discoverMovie(qs);
        if (data.results?.length > 0) {
          const pool = data.results.filter(m => !seenIds.has(m.id) && m.poster_path).slice(0, 12);
          if (pool.length > 0) {
            const pick = pool[Math.floor(Math.random() * pool.length)];
            seenIds.add(pick.id);
            results.push(pick);
          }
        }
      } catch {
        // continue
      }
    }
  }

  // Do not silently drop keywords/genres — that produced misleading picks (e.g. wrong keyword id
  // yielded 0 TMDB hits, then we refetched without the hone-in and showed random comedies).
  if (results.length === 0 && (tuning.keywordIds.length > 0 || tuning.extraGenreIds.length > 0)) {
    return [];
  }
  if (results.length === 0) return fetchFinalMovies(answers, viewerMode);
  return results;
}

async function fetchFinalMovies(answers, viewerMode = "casual") {
  const results = [];
  const seenIds = new Set();
  for (let i = 0; i < 6; i++) {
    const qs = buildParams(answers, i, viewerMode);
    try {
      const data = await tmdb.discoverMovie(qs);
      if (data.results?.length > 0) {
        const pool = data.results.filter(m => !seenIds.has(m.id) && m.poster_path).slice(0, 12);
        if (pool.length > 0) {
          const pick = pool[Math.floor(Math.random() * pool.length)];
          seenIds.add(pick.id);
          results.push(pick);
        }
      }
    } catch {
      // ignore: best-effort sampling across multiple attempts
    }
  }

  // Fallback: if strict filters or transient errors yield nothing,
  // return a few broadly popular picks so the UI never dead-ends.
  if (results.length === 0) {
    try {
      const qs = buildPreviewParams(answers);
      const data = await tmdb.discoverMovie(qs);
      const pool = (data.results || []).filter(m => m.poster_path).slice(0, 8);
      return pool;
    } catch {
      return [];
    }
  }
  return results;
}

/** Load extra recommendations not already in `seenIds`. Tries several discover pages/variants until at least `minResults` or `maxAttempts` is reached. */
async function fetchMoreMovies(answers, seenIds, viewerMode = "casual", options = {}) {
  const minResults = options.minResults ?? 5;
  const maxAttempts = options.maxAttempts ?? 22;
  const streamDefs = options.streamDefs;
  const tuning = options.tuning && (options.tuning.keywordIds?.length || options.tuning.extraGenreIds?.length)
    ? normalizeTuning(options.tuning)
    : null;
  const seen = new Set(seenIds);
  const batch = [];
  const salt = Math.floor(Math.random() * 900) + 1;
  const providerPipe = streamDefs?.length ? providerPipeFromStreamDefs(streamDefs) : "";
  const regions = streamDefs?.length ? ["NL", "US"] : [null];
  const requiredIds = streamDefs?.length ? [...new Set(streamDefs.flatMap(d => d.ids))] : [];

  for (let attempt = 0; attempt < maxAttempts && batch.length < minResults; attempt++) {
    const region = streamDefs?.length ? regions[attempt % regions.length] : null;
    const stream = providerPipe && region ? { watchRegion: region, providerPipe } : null;
    const qsBase = buildParams(answers, attempt, viewerMode, stream, tuning);
    const params = new URLSearchParams(qsBase);
    params.set("page", String((attempt * 5 + salt + (region?.charCodeAt(0) || 0)) % 22 + 1));
    const qs = params.toString();
    try {
      const data = await tmdb.discoverMovie(qs);
      let pool = (data.results || []).filter(m => !seen.has(m.id) && m.poster_path);
      if (requiredIds.length > 0 && pool.length > 0) {
        const head = pool.slice(0, 20);
        const checks = await Promise.all(head.map(m => movieHasAnyWatchProvider(m.id, requiredIds)));
        pool = head.filter((m, idx) => checks[idx]);
      }
      for (const m of pool) {
        if (batch.length >= minResults) break;
        seen.add(m.id);
        batch.push(m);
      }
    } catch {
      // best-effort: try next attempt
    }
  }
  return batch;
}

function getMoodLabel(answers) {
  const i = { escape: "escapist", feel: "emotional", laugh: "fun", think: "cerebral" };
  const e = { low: "low-key", medium: "relaxed", high: "charged" };
  return `${e[answers.energy] || ""} ${i[answers.intent] || ""} night`.trim();
}

// ─── Watch providers ─────────────────────────────────────────────────────────
// TMDB returns providers per country. NL is preferred for ordering, but we **merge NL + US**
// (deduped by provider_id) so the card matches discover: a title can be on Netflix in the US
// while NL only lists rent/buy — the old logic picked NL whenever NL had *any* rent and hid US streaming.
function mergeProviderLists(nlList, usList) {
  const seen = new Set();
  const out = [];
  for (const list of [nlList, usList]) {
    for (const p of list || []) {
      if (!p?.provider_id || seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      out.push(p);
    }
  }
  return out;
}

async function fetchWatchProviders(movieId) {
  const data = await tmdb.watchProviders(movieId);
  const nl = data.results?.NL;
  const us = data.results?.US;
  const flatrate = mergeProviderLists(nl?.flatrate, us?.flatrate);
  const rent = mergeProviderLists(nl?.rent, us?.rent);
  const buy = mergeProviderLists(nl?.buy, us?.buy);
  if (!flatrate.length && !rent.length && !buy.length) return null;
  return {
    flatrate,
    rent,
    buy,
    link: nl?.link || us?.link || null,
  };
}

/** True if the title has at least one of these provider_ids on flatrate or rent in NL or US (raw TMDB). */
async function movieHasAnyWatchProvider(movieId, providerIds) {
  const need = new Set(providerIds);
  if (need.size === 0) return true;
  try {
    const data = await tmdb.watchProviders(movieId);
    for (const code of ["NL", "US"]) {
      const r = data.results?.[code];
      if (!r) continue;
      for (const p of [...(r.flatrate || []), ...(r.rent || [])]) {
        if (need.has(p.provider_id)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

// Sidebar filters: TMDB provider_id values (incl. regional variants where common).
// A film matches if it has ANY selected service on flatrate or rent for NL→US fallback (same as cards).
const STREAMING_SERVICE_FILTERS = [
  { key: "netflix", label: "Netflix", ids: [8], accent: "#E50914" },
  { key: "prime", label: "Prime Video", ids: [9, 119, 10], accent: "#00A8E0" },
  { key: "disney", label: "Disney+", ids: [337], accent: "#113CCF" },
  { key: "appletv", label: "Apple TV+", ids: [350], accent: "#8e8e93" },
  { key: "max", label: "Max / HBO", ids: [1899, 384], accent: "#002BE7" },
  { key: "hulu", label: "Hulu", ids: [15], accent: "#1CE783" },
  { key: "paramount", label: "Paramount+", ids: [531], accent: "#0064FF" },
  { key: "peacock", label: "Peacock", ids: [386, 387], accent: "#c49a00" },
  { key: "mubi", label: "Mubi", ids: [11], accent: "#3885F3" },
  { key: "crunchyroll", label: "Crunchyroll", ids: [283], accent: "#F47521" },
];

// TMDB keyword ids (discover `with_keywords`, pipe = OR). Curated for “hone in” on results.
const KEYWORD_HONE_PRESETS = [
  { id: 12565, label: "Psychological thriller" },
  { id: 10049, label: "Heist" },
  { id: 9748, label: "Revenge" },
  { id: 4379, label: "Time travel" },
  { id: 10612, label: "Coming of age" },
  { id: 818, label: "Based on a book" },
  { id: 9672, label: "True story" },
  { id: 18035, label: "Superhero" },
  { id: 3133, label: "Vampire" },
  { id: 14964, label: "Satire" },
  { id: 6038, label: "Martial arts" },
  { id: 9799, label: "Courtroom" },
  { id: 4458, label: "Dystopia" },
];

// Extra genre OR-chips (merged into mood `with_genres`).
const GENRE_ADDON_PRESETS = [
  { id: GENRES.animation, label: "Animation" },
  { id: 99, label: "Documentary" },
  { id: GENRES.romance, label: "Romance" },
  { id: GENRES.scifi, label: "Sci‑Fi" },
  { id: GENRES.crime, label: "Crime" },
  { id: 10752, label: "War" },
  { id: 36, label: "History" },
  { id: 37, label: "Western" },
  { id: 10402, label: "Music" },
];

// Map provider IDs to brand colors for visual identity
const PROVIDER_COLORS = {
  "Netflix": "#E50914",
  "Amazon Prime Video": "#00A8E0",
  "Disney Plus": "#113CCF",
  "Apple TV Plus": "#000000",
  "Apple TV": "#000000",
  "HBO Max": "#002BE7",
  "Max": "#002BE7",
  "Hulu": "#1CE783",
  "Paramount Plus": "#0064FF",
  "Peacock": "#000000",
  "Mubi": "#000000",
  "KPN": "#009B77",
  "Pathé Thuis": "#E30613",
  "Videoland": "#FF0000",
};

function providerColor(name) {
  for (const [key, color] of Object.entries(PROVIDER_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return color;
  }
  return "rgba(232,213,183,0.15)";
}

function WatchProviders({ movieId }) {
  const [providers, setProviders] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetchWatchProviders(movieId)
      .then(p => { setProviders(p); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [movieId]);

  if (!loaded) return <div style={{ height: 32 }} />;
  if (!providers || (!providers.flatrate.length && !providers.rent.length)) {
    return <p style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(232,213,183,0.2)", margin: 0, letterSpacing: "1px" }}>not available in your region</p>;
  }

  const streaming = providers.flatrate.slice(0, 5);
  const rentals = providers.rent.slice(0, 4);
  const watchLink = providers.link;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {streaming.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "1px", color: "rgba(232,213,183,0.3)", textTransform: "uppercase" }}>Streaming</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {streaming.map(p => (
              <ProviderBadge key={p.provider_id} provider={p} link={watchLink} />
            ))}
          </div>
        </div>
      )}
      {rentals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <span style={{ fontFamily: "monospace", fontSize: 8, letterSpacing: "1px", color: "rgba(232,213,183,0.3)", textTransform: "uppercase" }}>Rent / Buy</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {rentals.map(p => (
              <ProviderBadge key={p.provider_id} provider={p} link={watchLink} size="sm" />
            ))}
          </div>
        </div>
      )}
      {watchLink && (
        <a
          href={watchLink}
          target="_blank"
          rel="noopener noreferrer"
          style={S_WP.watchNowLink}
        >
          All streaming options →
        </a>
      )}
    </div>
  );
}

function ProviderBadge({ provider, link, size = "md" }) {
  const [imgErr, setImgErr] = useState(false);
  const [hovered, setHovered] = useState(false);
  const logoUrl = provider.logo_path ? `https://image.tmdb.org/t/p/w45${provider.logo_path}` : null;
  const dim = size === "sm" ? 26 : 32;
  const color = providerColor(provider.provider_name);

  const inner = (
    <>
      {logoUrl && !imgErr ? (
        <img
          src={logoUrl}
          alt={provider.provider_name}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          onError={() => setImgErr(true)}
        />
      ) : (
        <span style={{ fontFamily: "monospace", fontSize: 7, color: "#fff", fontWeight: "bold", padding: "0 2px", textAlign: "center", lineHeight: 1.2 }}>
          {provider.provider_name.slice(0, 3).toUpperCase()}
        </span>
      )}
    </>
  );

  const badgeStyle = {
    width: dim, height: dim,
    borderRadius: 5,
    overflow: "hidden",
    flexShrink: 0,
    background: color,
    display: "flex", alignItems: "center", justifyContent: "center",
    border: hovered ? "2px solid rgba(255,255,255,0.5)" : "1px solid rgba(255,255,255,0.1)",
    transition: "all 0.15s",
    transform: hovered ? "scale(1.12)" : "scale(1)",
    cursor: link ? "pointer" : "default",
    textDecoration: "none",
  };

  if (link) {
    return (
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        title={`Watch on ${provider.provider_name}`}
        style={badgeStyle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {inner}
      </a>
    );
  }

  return (
    <div title={provider.provider_name} style={badgeStyle}>
      {inner}
    </div>
  );
}

// Inline style for WatchProviders "All streaming options" link
// (kept separate to avoid cluttering S object)
const S_WP = {
  watchNowLink: {
    display: "inline-flex",
    alignItems: "center",
    fontFamily: "monospace",
    fontSize: 9,
    letterSpacing: "1px",
    color: "rgba(232,213,183,0.45)",
    textDecoration: "none",
    textTransform: "uppercase",
    borderBottom: "1px solid rgba(232,213,183,0.2)",
    paddingBottom: 1,
    marginTop: 2,
    transition: "color 0.15s",
  },
};

// ─── Top bar: viewer mode + answer timeline ──────────────────────────────────
function TopBar({ viewerMode, onModeChange, answers, onAnswerChange, isNarrow, isPhone }) {
  const [openSlot, setOpenSlot] = useState(null);
  const barRef = useRef(null);
  const choicesBtnRef = useRef(null);
  const choicesDropRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) {
        setOpenSlot(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Build ordered list of answered steps from ALL_Q_DEFS
  const answeredSteps = ALL_Q_DEFS.filter(q => answers[q.id] !== undefined);
  const answeredCount = answeredSteps.length;

  const layoutChoicesDropdown = useCallback(() => {
    const btn = choicesBtnRef.current;
    const drop = choicesDropRef.current;
    if (!isPhone || openSlot !== "__choices" || !btn || !drop) return;

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const pad = 12;
    const maxW = Math.min(360, Math.max(220, vw - pad * 2));

    drop.style.position = "fixed";
    drop.style.zIndex = "600";
    drop.style.width = `${maxW}px`;
    drop.style.minWidth = "0px";
    drop.style.maxHeight = "360px";
    drop.style.overflowY = "auto";

    const br = btn.getBoundingClientRect();
    // Measure with the final width applied
    const dr = drop.getBoundingClientRect();

    // Prefer aligning the dropdown's right edge with the button's right edge,
    // then clamp so it stays fully inside the viewport.
    let left = br.right - dr.width;
    left = Math.min(left, vw - pad - dr.width);
    left = Math.max(left, pad);

    drop.style.top = `${Math.round(br.bottom + 8)}px`;
    drop.style.left = `${Math.round(left)}px`;
    drop.style.visibility = "visible";
  }, [isPhone, openSlot]);

  useLayoutEffect(() => {
    const drop = choicesDropRef.current;
    if (!isPhone || openSlot !== "__choices") {
      if (drop) drop.style.visibility = "";
      return;
    }
    if (drop) drop.style.visibility = "hidden";
    layoutChoicesDropdown();
  }, [isPhone, openSlot, layoutChoicesDropdown, answeredCount]);

  useEffect(() => {
    if (!isPhone || openSlot !== "__choices") return;
    const onResize = () => layoutChoicesDropdown();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [isPhone, openSlot, layoutChoicesDropdown]);

  const handleSlotClick = (qId) => {
    setOpenSlot(openSlot === qId ? null : qId);
  };

  const handleOptionClick = (qId, val) => {
    setOpenSlot(null);
    if (onAnswerChange) onAnswerChange(qId, val);
  };

  return (
    <div
      ref={barRef}
      style={{
        ...S.topBar,
        padding: isNarrow ? "8px 12px" : S.topBar.padding,
        height: isNarrow ? "auto" : S.topBar.height,
        gap: isNarrow ? 12 : S.topBar.gap,
        flexWrap: isNarrow ? "wrap" : "nowrap",
      }}
    >
      {/* FlickMatch logo */}
      <a
        href="#"
        style={S.topBarLogo}
        onClick={e => { e.preventDefault(); window.location.reload(); }}
      >
        <span>🎬</span>
        <span>FlickMatch</span>
      </a>

      {/* Timeline: viewer mode + answers */}
      <div style={{ ...S.topBarTimeline, gap: isNarrow ? 6 : S.topBarTimeline.gap }}>

        {/* Viewer mode pill */}
        <div style={{ position: "relative" }}>
          <button
            style={{ ...S.topBarPill, ...S.topBarPillMode, ...(openSlot === "__mode" ? S.topBarPillOpen : {}) }}
            onClick={() => setOpenSlot(openSlot === "__mode" ? null : "__mode")}
          >
            <span>{VIEWER_MODES[viewerMode].emoji}</span>
            <span>{VIEWER_MODES[viewerMode].label}</span>
            <span style={S.topBarChevron}>▾</span>
          </button>
          {openSlot === "__mode" && (
            <div style={S.topBarDropdown}>
              {Object.entries(VIEWER_MODES).map(([key, mode]) => (
                <button
                  key={key}
                  style={{ ...S.topBarDropItem, ...(viewerMode === key ? S.topBarDropItemActive : {}) }}
                  onClick={() => { onModeChange(key); setOpenSlot(null); if (onAnswerChange && Object.keys(answers).length > 0) onAnswerChange("__refetch__", key); }}
                >
                  <span>{mode.emoji}</span>
                  <span>{mode.label}</span>
                  <span style={{ fontFamily: "Georgia,serif", fontStyle: "italic", fontSize: 10, color: "rgba(232,213,183,0.4)", marginLeft: 4 }}>{mode.desc}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Separator */}
        {answeredCount > 0 && <div style={S.topBarSep} />}

        {/* On narrow screens, collapse the timeline into a single dropdown to keep the bar short */}
        {isNarrow ? (
          <div style={{ position: "relative" }}>
            <button
              ref={choicesBtnRef}
              style={{ ...S.topBarPill, ...(openSlot === "__choices" ? S.topBarPillOpen : {}) }}
              onClick={() => setOpenSlot(openSlot === "__choices" ? null : "__choices")}
            >
              <span style={{ fontSize: 12 }}>Choices</span>
              <span style={{ fontFamily: "monospace", fontSize: 10, opacity: 0.7 }}>({answeredCount})</span>
              <span style={S.topBarChevron}>▾</span>
            </button>
            {openSlot === "__choices" && (
              <div
                ref={choicesDropRef}
                style={{
                  ...S.topBarDropdown,
                  ...(!isPhone
                    ? { minWidth: 280 }
                    : {}),
                  ...(isPhone ? { top: "auto", left: "auto", right: "auto", minWidth: 0 } : {}),
                  maxHeight: 360,
                  overflowY: "auto",
                }}
              >
                <p style={S.topBarDropLabel}>Your choices</p>
                {answeredSteps.map(q => {
                  const current = q.options.find(o => o.value === answers[q.id]);
                  return (
                    <div key={q.id} style={{ padding: "10px 12px", borderBottom: "1px solid rgba(232,213,183,0.09)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                        <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(232,213,183,0.45)" }}>
                          {q.label}
                        </span>
                        <span style={{ fontFamily: "Georgia,serif", fontSize: 12, color: "rgba(232,213,183,0.9)" }}>
                          {current?.emoji} {current?.label}
                        </span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6, marginTop: 8 }}>
                        {q.options.map(opt => (
                          <button
                            key={opt.value}
                            style={{
                              ...S.topBarDropItem,
                              padding: "8px 10px",
                              border: "1px solid rgba(232,213,183,0.12)",
                              ...(answers[q.id] === opt.value ? S.topBarDropItemActive : {}),
                            }}
                            onClick={() => handleOptionClick(q.id, opt.value)}
                          >
                            <span>{opt.emoji}</span>
                            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{opt.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Answer steps */}
            {answeredSteps.map((q, i) => {
              const current = q.options.find(o => o.value === answers[q.id]);
              const isOpen = openSlot === q.id;
              return (
                <div key={q.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
                  {i > 0 && <span style={S.topBarArrow}>›</span>}
                  <button
                    style={{ ...S.topBarPill, ...(isOpen ? S.topBarPillOpen : {}) }}
                    onClick={() => handleSlotClick(q.id)}
                  >
                    <span>{current?.emoji}</span>
                    <span style={{ maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.label}</span>
                    <span style={S.topBarChevron}>▾</span>
                  </button>
                  {isOpen && (
                    <div style={S.topBarDropdown}>
                      <p style={S.topBarDropLabel}>{q.label}</p>
                      {q.options.map(opt => (
                        <button
                          key={opt.value}
                          style={{ ...S.topBarDropItem, ...(answers[q.id] === opt.value ? S.topBarDropItemActive : {}) }}
                          onClick={() => handleOptionClick(q.id, opt.value)}
                        >
                          <span>{opt.emoji}</span>
                          <span>{opt.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep] = useState("intro");
  const [viewerMode, setViewerMode] = useState("casual");
  const [allQuestions, setAllQuestions] = useState(CORE_QUESTIONS);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState({});
  const [movies, setMovies] = useState([]);
  const [previewMovies, setPreviewMovies] = useState([]);
  const [animating, setAnimating] = useState(false);
  const [selected, setSelected] = useState(null);
  const viewportW = useViewportWidth();
  const isNarrow = viewportW < 900;
  const isPhone = viewportW < 600;

  // Always keep the preview refreshed whenever answers change
  useEffect(() => {
    if (step !== "questions") return;
    fetchPreviewMovies(answers).then(setPreviewMovies).catch(() => {});
  }, [answers, step]);

  const handleAnswer = useCallback((value) => {
    if (animating) return;
    setSelected(value);
    setAnimating(true);

    const newAnswers = { ...answers, [allQuestions[currentQ].id]: value };
    setAnswers(newAnswers);

    // Inject adaptive questions after last core question
    let questions = allQuestions;
    if (currentQ === CORE_QUESTIONS.length - 1) {
      const adaptive = getAdaptiveQuestions(newAnswers);
      questions = [...CORE_QUESTIONS, ...adaptive];
      setAllQuestions(questions);
    }

    setTimeout(async () => {
      if (currentQ < questions.length - 1) {
        setCurrentQ(q => q + 1);
        setSelected(null);
        setAnimating(false);
      } else {
        setStep("loading");
        try {
          const picks = await fetchFinalMovies(newAnswers, viewerMode);
          setMovies(picks);
          setStep(picks.length > 0 ? "results" : "empty");
        } catch { setStep("error"); }
      }
    }, 360);
  }, [animating, answers, allQuestions, currentQ, viewerMode]);

  const fullReset = () => {
    setStep("intro"); setCurrentQ(0); setAnswers({});
    setMovies([]); setPreviewMovies([]); setSelected(null);
    setAnimating(false); setAllQuestions(CORE_QUESTIONS);
  };

  const refineResults = () => {
    const refineQ = {
      id: "refine",
      text: "What was off about those picks?",
      options: [
        { label: "Too mainstream", value: "too_mainstream", emoji: "🙄" },
        { label: "Wrong genre", value: "wrong_genre", emoji: "🎭" },
        { label: "Too heavy", value: "too_heavy", emoji: "😓" },
        { label: "Too light", value: "too_light", emoji: "🪶" },
      ],
    };
    setAllQuestions([refineQ]);
    setCurrentQ(0);
    setSelected(null);
    setAnimating(false);
    setMovies([]);
    setStep("questions");
  };

  const handleRefine = useCallback((value) => {
    const refined = { ...answers };
    if (value === "too_mainstream") refined.familiar = "hidden";
    else if (value === "wrong_genre") { delete refined.intent; delete refined.escape_type; delete refined.feel_type; delete refined.think_type; delete refined.laugh_type; }
    else if (value === "too_heavy") { refined.intensity = "light"; delete refined.dark_type; }
    else if (value === "too_light") { refined.intensity = "dark"; }
    setAnswers(refined);
    setAnimating(true);
    setSelected(value);
    setTimeout(async () => {
      setStep("loading");
      try {
        const picks = await fetchFinalMovies(refined, viewerMode);
        setMovies(picks);
        setStep(picks.length > 0 ? "results" : "empty");
      } catch { setStep("error"); }
      finally { setAnimating(false); }
    }, 360);
  }, [answers, viewerMode]);

  const isRefineQ = allQuestions[0]?.id === "refine";

  const handleAnswerChange = (qId, val) => {
    if (qId === "__refetch__") {
      // Mode changed — refetch with same answers but new mode
      setViewerMode(val);
      if (Object.keys(answers).length > 0) {
        setStep("loading");
        fetchFinalMovies(answers, val)
          .then(picks => { setMovies(picks); setStep(picks.length > 0 ? "results" : "empty"); })
          .catch(() => setStep("error"));
      }
      return;
    }
    const newAnswers = { ...answers, [qId]: val };
    setAnswers(newAnswers);
    if (step === "results") {
      setStep("loading");
      fetchFinalMovies(newAnswers, viewerMode)
        .then(picks => { setMovies(picks); setStep(picks.length > 0 ? "results" : "empty"); })
        .catch(() => setStep("error"));
    }
  };

  const showTopBar = step !== "intro";

  return (
    <div style={S.root}>
      <Grain />

      {/* Top bar — visible on all steps except intro */}
      {showTopBar && (
        <TopBar
          viewerMode={viewerMode}
          onModeChange={(m) => handleAnswerChange("__refetch__", m)}
          answers={answers}
          onAnswerChange={handleAnswerChange}
          isNarrow={isNarrow}
          isPhone={isPhone}
        />
      )}

      {/* Page content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px 16px", position: "relative", zIndex: 1 }}>
        {step === "intro" && <Intro onStart={() => setStep("questions")} viewerMode={viewerMode} onModeChange={setViewerMode} />}
        {step === "questions" && (
          <QLayout
            question={allQuestions[currentQ]}
            index={currentQ}
            total={allQuestions.length}
            onAnswer={isRefineQ ? handleRefine : handleAnswer}
            selected={selected}
            previewMovies={previewMovies}
            answers={answers}
            isNarrow={isNarrow}
            isPhone={isPhone}
          />
        )}
        {step === "loading" && <Loader />}
        {step === "results" && (
          <Results
            movies={movies}
            answers={answers}
            viewerMode={viewerMode}
            onRefine={refineResults}
            onReset={fullReset}
            onReplaceMovies={setMovies}
            isNarrow={isNarrow}
            isPhone={isPhone}
          />
        )}
        {(step === "error" || step === "empty") && (
          <div style={{ ...S.center, gap: 20, textAlign: "center" }}>
            <p style={{ color: "#e8d5b7", fontFamily: "Georgia,serif", maxWidth: 360 }}>
              {step === "empty" ? "No matches for that combo. Try adjusting?" : "Something went wrong."}
            </p>
            <button onClick={fullReset} style={S.btn}>Start over</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Question layout ──────────────────────────────────────────────────────────
function QLayout({ question, index, total, onAnswer, selected, previewMovies, answers, isNarrow, isPhone }) {
  const hasIntent = !!answers.intent || !!answers.familiar;

  if (isPhone) {
    return (
      <div style={{ ...S.qLayout, flexDirection: "column", gap: 20, padding: "0 0", width: "100%", maxWidth: 720 }}>
        <div style={{ width: "100%" }}>
          <div style={{ display: "flex", gap: 7, marginBottom: 18 }}>
            {Array.from({ length: total }).map((_, i) => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: "50%",
                background: i < index ? "rgba(232,213,183,0.35)" : i === index ? "#e8d5b7" : "rgba(232,213,183,0.12)",
                transform: i === index ? "scale(1.4)" : "scale(1)",
                transition: "all 0.3s",
              }} />
            ))}
          </div>
          <p style={{ ...S.qCounter, letterSpacing: "1.5px" }}>{index + 1} / {total}</p>
          <h2 style={{ ...S.qText, fontSize: "clamp(20px,6.2vw,30px)", lineHeight: 1.25 }}>{question.text}</h2>
          <div style={{ ...S.grid, gridTemplateColumns: "1fr", gap: 10 }}>
            {question.options.map(opt => (
              <button key={opt.value} onClick={() => onAnswer(opt.value)} style={{
                ...S.optBtn,
                ...(selected === opt.value ? S.optSelected : {}),
                padding: "16px 12px",
              }}>
                <span style={{ fontSize: 22 }}>{opt.emoji}</span>
                <span style={{ fontSize: 14, color: "rgba(232,213,183,0.85)" }}>{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ ...S.previewPanel, flex: "none", width: "100%", paddingTop: 0 }}>
          <p style={{ ...S.previewLabel, margin: "0 0 10px" }}>
            {hasIntent ? "considering…" : "what's out there"}
          </p>
          <div
            style={{
              ...S.posterGrid,
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: 5,
            }}
          >
            {previewMovies.length > 0
              ? previewMovies.map((m, i) => <PosterThumb key={m.id} movie={m} delay={i * 22} compact />)
              : Array.from({ length: 10 }).map((_, i) => <div key={i} style={S.posterPlaceholder} />)
            }
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        ...S.qLayout,
        flexDirection: isNarrow ? "column" : "row",
        gap: isNarrow ? 22 : S.qLayout.gap,
        padding: isNarrow ? "0 0" : S.qLayout.padding,
      }}
    >
      <div style={{ ...S.qPanel, flex: isNarrow ? "1 1 auto" : S.qPanel.flex, maxWidth: isNarrow ? "100%" : S.qPanel.maxWidth }}>
        {/* Progress dots */}
        <div style={{ display: "flex", gap: 7, marginBottom: 28 }}>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} style={{
              width: 6, height: 6, borderRadius: "50%",
              background: i < index ? "rgba(232,213,183,0.35)" : i === index ? "#e8d5b7" : "rgba(232,213,183,0.12)",
              transform: i === index ? "scale(1.4)" : "scale(1)",
              transition: "all 0.3s",
            }} />
          ))}
        </div>
        <p style={S.qCounter}>{index + 1} / {total}</p>
        <h2 style={S.qText}>{question.text}</h2>
        <div style={S.grid}>
          {question.options.map(opt => (
            <button key={opt.value} onClick={() => onAnswer(opt.value)} style={{
              ...S.optBtn,
              ...(selected === opt.value ? S.optSelected : {}),
            }}>
              <span style={{ fontSize: 24 }}>{opt.emoji}</span>
              <span style={{ fontSize: 13, color: "rgba(232,213,183,0.8)" }}>{opt.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Live preview panel — always shows something */}
      <div style={{ ...S.previewPanel, paddingTop: isNarrow ? 4 : S.previewPanel.paddingTop }}>
        <p style={S.previewLabel}>
          {hasIntent ? "considering…" : "what's out there"}
        </p>
        <div
          style={{
            ...S.posterGrid,
            gridTemplateColumns: isPhone ? "repeat(3, 1fr)" : (isNarrow ? "repeat(4, 1fr)" : S.posterGrid.gridTemplateColumns),
            gap: isNarrow ? 6 : S.posterGrid.gap,
          }}
        >
          {previewMovies.length > 0
            ? previewMovies.map((m, i) => <PosterThumb key={m.id} movie={m} delay={i * 35} />)
            : Array.from({ length: 12 }).map((_, i) => <div key={i} style={S.posterPlaceholder} />)
          }
        </div>
      </div>
    </div>
  );
}

// ─── Poster thumb with hover links ───────────────────────────────────────────
function PosterThumb({ movie, delay, compact }) {
  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [imdbId, setImdbId] = useState(null);

  useEffect(() => {
    tmdb.externalIds(movie.id)
      .then(d => { if (d?.imdb_id) setImdbId(d.imdb_id); })
      .catch(() => {});
  }, [movie.id]);

  const lbSlug = movie.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const posterPath = compact ? "w154" : "w185";

  return (
    <div
      // Keep the tile visible even if the image load event never fires
      // (can happen with cached images / fast transitions). We fade the image instead.
      style={{ ...S.thumbWrap }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <img
        src={`https://image.tmdb.org/t/p/${posterPath}${movie.poster_path}`}
        alt={movie.title}
        style={{
          ...S.thumb,
          opacity: loaded ? 1 : 0,
          filter: hovered ? "brightness(0.25)" : (compact ? "brightness(0.78)" : "brightness(0.72)"),
          transition: `opacity 0.35s ease ${delay}ms, filter 0.2s`,
        }}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
      {/* Title overlay */}
      <div style={{ ...S.thumbOverlay, opacity: hovered ? 0 : 1, transition: "opacity 0.2s", ...(compact ? { padding: "4px 4px 5px" } : {}) }}>
        <span style={compact ? { ...S.thumbTitle, fontSize: 7, WebkitLineClamp: 2 } : S.thumbTitle}>{movie.title}</span>
      </div>
      {/* Hover: links */}
      <div style={{ ...S.thumbHoverOverlay, opacity: hovered ? 1 : 0, transition: "opacity 0.2s", pointerEvents: hovered ? "auto" : "none", ...(compact ? { padding: "5px 4px", gap: 3 } : {}) }}>
        <span style={compact ? { ...S.thumbHoverTitle, fontSize: 8 } : S.thumbHoverTitle}>{movie.title}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: compact ? 3 : 4, width: "100%" }}>
          {imdbId && (
            <a href={`https://www.imdb.com/title/${imdbId}`} target="_blank" rel="noopener noreferrer" style={compact ? { ...S.linkBtn, padding: "3px 0", fontSize: 7 } : S.linkBtn} onClick={e => e.stopPropagation()}>
              IMDb ↗
            </a>
          )}
          <a href={`https://letterboxd.com/film/${lbSlug}`} target="_blank" rel="noopener noreferrer" style={{ ...(compact ? { ...S.linkBtn, ...S.linkBtnGreen, padding: "3px 0", fontSize: 7 } : { ...S.linkBtn, ...S.linkBtnGreen }) }} onClick={e => e.stopPropagation()}>
            Letterboxd ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Screens ──────────────────────────────────────────────────────────────────
function Intro({ onStart, viewerMode, onModeChange }) {
  return (
    <div style={{ ...S.center, gap: 32 }}>
      <div style={{ fontSize: 56, filter: "sepia(0.3)", marginBottom: -4 }}>🎬</div>
      <div style={{ textAlign: "center" }}>
        <h1 style={{ ...S.title, fontSize: "clamp(32px,6vw,52px)", letterSpacing: "-1px" }}>FlickMatch</h1>
        <p style={S.subtitle}>Answer a few questions. Get your perfect film.</p>
      </div>

      {/* Viewer mode selector */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <p style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", color: "rgba(232,213,183,0.3)", margin: 0 }}>
          I watch movies as a
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          {Object.entries(VIEWER_MODES).map(([key, mode]) => (
            <button
              key={key}
              onClick={() => onModeChange(key)}
              style={{
                ...S.modeBtn,
                ...(viewerMode === key ? S.modeBtnActive : {}),
              }}
              title={mode.desc}
            >
              <span style={{ fontSize: 16 }}>{mode.emoji}</span>
              <span>{mode.label}</span>
            </button>
          ))}
        </div>
        <p style={{ fontFamily: "Georgia,serif", fontStyle: "italic", fontSize: 12, color: "rgba(232,213,183,0.35)", margin: 0 }}>
          {VIEWER_MODES[viewerMode].desc}
        </p>
      </div>

      <button onClick={onStart} style={S.btn}>Find my film</button>
    </div>
  );
}

function Loader() {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? "" : d + "."), 440);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ ...S.center, gap: 20 }}>
      <div style={{ fontSize: 44 }}>🎞</div>
      <p style={{ ...S.title, fontSize: 20 }}>Searching the archive{dots}</p>
    </div>
  );
}

// Map of all question defs for the sidebar (core + adaptive)
const ALL_Q_DEFS = [
  { id: "intent", label: "Tonight", options: [
    { label: "Escape everything", value: "escape", emoji: "✈️" },
    { label: "Feel something real", value: "feel", emoji: "🌊" },
    { label: "Just laugh", value: "laugh", emoji: "😂" },
    { label: "Get my mind going", value: "think", emoji: "🧠" },
  ]},
  { id: "familiar", label: "Discovery", options: [
    { label: "Something new", value: "new", emoji: "🔭" },
    { label: "Hidden gem", value: "hidden", emoji: "💎" },
    { label: "Proven great", value: "classic", emoji: "🏆" },
    { label: "Surprise me", value: "surprise", emoji: "🎲" },
  ]},
  { id: "company", label: "Watching with", options: [
    { label: "Solo", value: "solo", emoji: "🌙" },
    { label: "Partner", value: "partner", emoji: "🫂" },
    { label: "Friends", value: "friends", emoji: "🍕" },
    { label: "Family", value: "family", emoji: "🏠" },
  ]},
  { id: "intensity", label: "Intensity", options: [
    { label: "Light", value: "light", emoji: "🌸" },
    { label: "Some tension", value: "medium", emoji: "🌗" },
    { label: "Hit me hard", value: "dark", emoji: "🌑" },
  ]},
  { id: "time", label: "Time", options: [
    { label: "Under 90 min", value: "short", emoji: "⏱️" },
    { label: "Full movie", value: "normal", emoji: "🎬" },
    { label: "Whatever it takes", value: "long", emoji: "🌃" },
  ]},
  { id: "escape_type", label: "Escape type", options: [
    { label: "Other worlds", value: "fantasy", emoji: "🌍" },
    { label: "Action & speed", value: "action", emoji: "💥" },
    { label: "Future tech", value: "scifi", emoji: "🚀" },
    { label: "Epic adventure", value: "adventure", emoji: "🗺️" },
  ]},
  { id: "feel_type", label: "Feeling", options: [
    { label: "Cry it out", value: "cry", emoji: "😢" },
    { label: "Inspired", value: "inspired", emoji: "✨" },
    { label: "Unsettled", value: "unsettled", emoji: "😶" },
    { label: "Warm inside", value: "warm", emoji: "🌅" },
  ]},
  { id: "think_type", label: "Challenge", options: [
    { label: "Mind-bending", value: "mindbend", emoji: "🌀" },
    { label: "Psychological", value: "psych", emoji: "🧠" },
    { label: "Crime", value: "crime", emoji: "🔍" },
    { label: "Slow burn", value: "slowburn", emoji: "🕯️" },
  ]},
  { id: "laugh_type", label: "Comedy type", options: [
    { label: "Stupid & loud", value: "stupid", emoji: "🤡" },
    { label: "Dry wit", value: "dry", emoji: "🧂" },
    { label: "Awkward cringe", value: "cringe", emoji: "😬" },
    { label: "Heartfelt", value: "warm", emoji: "🌻" },
  ]},
  { id: "dark_type", label: "Darkness", options: [
    { label: "Tense thriller", value: "thriller", emoji: "😰" },
    { label: "Dark drama", value: "drama", emoji: "🖤" },
    { label: "Horror", value: "horror", emoji: "👁️" },
    { label: "Bleak & beautiful", value: "arthouse", emoji: "🎭" },
  ]},
  { id: "new_origin", label: "Origin", options: [
    { label: "Anywhere", value: "any", emoji: "🌐" },
    { label: "European", value: "europe", emoji: "🗼" },
    { label: "Asian cinema", value: "asia", emoji: "🏮" },
    { label: "American indie", value: "indie", emoji: "🎸" },
  ]},
];

function AnswerSidebar({ answers, onAnswerChange }) {
  const [expandedQ, setExpandedQ] = useState(null);

  // Only show questions that have been answered
  const answered = ALL_Q_DEFS.filter(q => answers[q.id] !== undefined);

  return (
    <div style={S.sidebar}>
      <p style={S.sidebarHeading}>Your choices</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {answered.map(q => {
          const current = q.options.find(o => o.value === answers[q.id]);
          const isOpen = expandedQ === q.id;
          return (
            <div key={q.id} style={S.sidebarRow}>
              <div
                style={S.sidebarItem}
                onClick={() => setExpandedQ(isOpen ? null : q.id)}
              >
                <span style={S.sidebarLabel}>{q.label}</span>
                <span style={S.sidebarValue}>
                  {current?.emoji} {current?.label}
                  <span style={{ ...S.sidebarChevron, transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}>▾</span>
                </span>
              </div>
              {isOpen && (
                <div style={S.sidebarOptions}>
                  {q.options.map(opt => (
                    <button
                      key={opt.value}
                      style={{
                        ...S.sidebarOpt,
                        ...(answers[q.id] === opt.value ? S.sidebarOptActive : {}),
                      }}
                      onClick={() => {
                        onAnswerChange(q.id, opt.value);
                        setExpandedQ(null);
                      }}
                    >
                      <span>{opt.emoji}</span>
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Results({ movies, answers, viewerMode, onRefine, onReset, onReplaceMovies, isNarrow, isPhone }) {
  const [moreMovies, setMoreMovies] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreExhausted, setLoadMoreExhausted] = useState(false);
  const [streamFiltersOn, setStreamFiltersOn] = useState({});
  const [keywordOn, setKeywordOn] = useState({});
  const [genreAddonOn, setGenreAddonOn] = useState({});
  const [tuningFetchLoading, setTuningFetchLoading] = useState(false);
  const [streamPhoneOpen, setStreamPhoneOpen] = useState(false);
  const [streamSidebarOpen, setStreamSidebarOpen] = useState(false);
  const [honeKeywordsOpen, setHoneKeywordsOpen] = useState(false);
  const [honeGenresOpen, setHoneGenresOpen] = useState(false);
  const prevHadTuningRef = useRef(false);

  const activeStreamDefs = useMemo(
    () => STREAMING_SERVICE_FILTERS.filter(f => streamFiltersOn[f.key]),
    [streamFiltersOn]
  );
  const keywordIds = useMemo(
    () => Object.entries(keywordOn).filter(([, v]) => v).map(([id]) => Number(id)).filter(Number.isFinite).sort((a, b) => a - b),
    [keywordOn]
  );
  const genreAddonIds = useMemo(
    () => Object.entries(genreAddonOn).filter(([, v]) => v).map(([id]) => Number(id)).filter(Number.isFinite).sort((a, b) => a - b),
    [genreAddonOn]
  );
  const tuningActive = activeStreamDefs.length > 0 || keywordIds.length > 0 || genreAddonIds.length > 0;
  const tuningSignature = useMemo(
    () => `${activeStreamDefs.map(d => d.key).sort().join(",")}|${keywordIds.join(",")}|${genreAddonIds.join(",")}`,
    [activeStreamDefs, keywordIds, genreAddonIds]
  );

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!tuningActive) {
        if (prevHadTuningRef.current) {
          prevHadTuningRef.current = false;
          setTuningFetchLoading(true);
          setMoreMovies([]);
          setLoadMoreExhausted(false);
          try {
            const list = await fetchFinalMovies(answers, viewerMode);
            if (!cancelled) onReplaceMovies(list);
          } finally {
            if (!cancelled) setTuningFetchLoading(false);
          }
        }
        return;
      }
      prevHadTuningRef.current = true;
      setTuningFetchLoading(true);
      setMoreMovies([]);
      setLoadMoreExhausted(false);
      try {
        const list = await fetchResultsWithTuning(answers, viewerMode, {
          streamDefs: activeStreamDefs.length ? activeStreamDefs : null,
          keywordIds,
          extraGenreIds: genreAddonIds,
        });
        if (!cancelled) onReplaceMovies(list);
      } finally {
        if (!cancelled) setTuningFetchLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [tuningActive, tuningSignature, answers, viewerMode, onReplaceMovies]);

  const toggleStreamFilter = (key) => {
    setStreamFiltersOn(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleKeyword = (id) => {
    setKeywordOn(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleGenreAddon = (id) => {
    setGenreAddonOn(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const clearStreamFilters = () => {
    setStreamFiltersOn({});
    setStreamPhoneOpen(false);
    setStreamSidebarOpen(false);
  };

  const clearAllTuning = () => {
    setStreamFiltersOn({});
    setKeywordOn({});
    setGenreAddonOn({});
    setStreamPhoneOpen(false);
    setStreamSidebarOpen(false);
    setHoneKeywordsOpen(false);
    setHoneGenresOpen(false);
  };

  /** Phone: only one refine panel open at a time — keeps the stack short so picks stay primary. */
  const phoneOpenKeywords = () => {
    setHoneKeywordsOpen(v => {
      const next = !v;
      if (next) {
        setHoneGenresOpen(false);
        setStreamPhoneOpen(false);
      }
      return next;
    });
  };
  const phoneOpenGenres = () => {
    setHoneGenresOpen(v => {
      const next = !v;
      if (next) {
        setHoneKeywordsOpen(false);
        setStreamPhoneOpen(false);
      }
      return next;
    });
  };
  const phoneOpenStreaming = () => {
    setStreamPhoneOpen(v => {
      const next = !v;
      if (next) {
        setHoneKeywordsOpen(false);
        setHoneGenresOpen(false);
      }
      return next;
    });
  };

  const handleLoadMorePicks = async () => {
    setLoadingMore(true);
    try {
      const seenIds = [...movies, ...moreMovies].map(m => m.id);
      const tuning = keywordIds.length || genreAddonIds.length
        ? { keywordIds, extraGenreIds: genreAddonIds }
        : undefined;
      const more = await fetchMoreMovies(answers, seenIds, viewerMode, {
        minResults: 5,
        maxAttempts: 28,
        streamDefs: activeStreamDefs.length ? activeStreamDefs : undefined,
        tuning,
      });
      if (more.length === 0) setLoadMoreExhausted(true);
      else setLoadMoreExhausted(false);
      setMoreMovies(prev => [...prev, ...more]);
    } catch {
      // keep prior list; user can retry
    }
    finally { setLoadingMore(false); }
  };

  const moodLabel = getMoodLabel(answers);

  const phonePickSummary = tuningActive
    ? `${movies.length}${moreMovies.length ? `+${moreMovies.length}` : ""} refined`
    : `${movies.length}${moreMovies.length ? `+${moreMovies.length}` : ""} picks`;

  const honeOptionRow = (on, compact) => ({
    ...S.streamFilterBtn,
    width: "100%",
    textAlign: "left",
    boxSizing: "border-box",
    padding: compact ? "5px 8px" : "6px 9px",
    marginBottom: compact ? 3 : 4,
    fontSize: 10,
    ...(on ? S.streamFilterBtnOn : {}),
  });

  const honeDropdownTrigger = (compact) => ({
    ...S.btn,
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: compact ? 10 : 11,
    padding: compact ? "6px 8px" : "6px 8px",
    textAlign: "left",
    marginBottom: compact ? 4 : 6,
    opacity: 0.9,
  });

  return (
    <div
      style={{
        ...S.resultsLayout,
        flexDirection: isNarrow ? "column" : "row",
        gap: isNarrow ? (isPhone ? 10 : 18) : S.resultsLayout.gap,
        padding: isNarrow ? (isPhone ? "8px 0 0" : "18px 0") : S.resultsLayout.padding,
      }}
    >

      {/* ── Left sidebar ── */}
      <div
        style={{
          ...S.resSidebar,
          position: isNarrow ? "static" : S.resSidebar.position,
          width: isNarrow ? "100%" : S.resSidebar.width,
          top: isNarrow ? "auto" : S.resSidebar.top,
          alignSelf: isNarrow ? "stretch" : S.resSidebar.alignSelf,
          maxHeight: isNarrow ? "none" : S.resSidebar.maxHeight,
          overflowY: isNarrow ? "visible" : S.resSidebar.overflowY,
          paddingRight: isNarrow ? 0 : S.resSidebar.paddingRight,
          zIndex: isNarrow ? "auto" : S.resSidebar.zIndex,
          order: isPhone ? 2 : 0,
          minWidth: 0,
        }}
      >
        {isPhone ? (
          <div
            style={{
              border: "1px solid rgba(232,213,183,0.1)",
              borderRadius: 8,
              padding: "6px 8px 8px",
              background: "rgba(232,213,183,0.02)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
              <span style={{ fontFamily: "monospace", fontSize: 7, letterSpacing: "1.2px", textTransform: "uppercase", color: "rgba(232,213,183,0.3)" }}>
                Session
              </span>
              <span style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(232,213,183,0.45)", whiteSpace: "nowrap" }}>{phonePickSummary}</span>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 4 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontFamily: "monospace", fontSize: 6, letterSpacing: "0.8px", textTransform: "uppercase", color: "rgba(232,213,183,0.26)", margin: "0 0 1px" }}>Mood</p>
                <p style={{
                  fontFamily: "Georgia,serif",
                  fontSize: 10,
                  color: "#e8d5b7",
                  margin: 0,
                  fontStyle: "italic",
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                >
                  {moodLabel}
                </p>
              </div>
              <div style={{ flexShrink: 0, textAlign: "right", maxWidth: "42%" }}>
                <p style={{ fontFamily: "monospace", fontSize: 6, letterSpacing: "0.8px", textTransform: "uppercase", color: "rgba(232,213,183,0.26)", margin: "0 0 1px" }}>As</p>
                <p style={{ fontFamily: "Georgia,serif", fontSize: 10, color: "#e8d5b7", margin: 0, lineHeight: 1.2 }}>
                  {VIEWER_MODES[viewerMode].emoji} {VIEWER_MODES[viewerMode].label}
                </p>
              </div>
            </div>
            <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid rgba(232,213,183,0.07)" }}>
              <button
                type="button"
                onClick={phoneOpenKeywords}
                aria-expanded={honeKeywordsOpen}
                style={honeDropdownTrigger(true)}
              >
                <span style={{ fontFamily: "Georgia,serif", color: "#c8b99a" }}>
                  Keywords
                  {keywordIds.length > 0 && (
                    <span style={{ fontFamily: "monospace", fontSize: 8, color: "rgba(200,169,110,0.95)", marginLeft: 6 }}>
                      {keywordIds.length} on
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 8, color: "rgba(232,213,183,0.45)", flexShrink: 0 }}>{honeKeywordsOpen ? "▴" : "▾"}</span>
              </button>
              {honeKeywordsOpen && (
                <div style={{ marginBottom: 6 }}>
                  {KEYWORD_HONE_PRESETS.map(kw => {
                    const on = !!keywordOn[kw.id];
                    return (
                      <button key={kw.id} type="button" onClick={() => toggleKeyword(kw.id)} style={honeOptionRow(on, true)}>
                        {on ? "✓ " : ""}{kw.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                onClick={phoneOpenGenres}
                aria-expanded={honeGenresOpen}
                style={honeDropdownTrigger(true)}
              >
                <span style={{ fontFamily: "Georgia,serif", color: "#c8b99a" }}>
                  Genres
                  {genreAddonIds.length > 0 && (
                    <span style={{ fontFamily: "monospace", fontSize: 8, color: "rgba(200,169,110,0.95)", marginLeft: 6 }}>
                      {genreAddonIds.length} on
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 8, color: "rgba(232,213,183,0.45)", flexShrink: 0 }}>{honeGenresOpen ? "▴" : "▾"}</span>
              </button>
              {honeGenresOpen && (
                <div style={{ marginBottom: 6 }}>
                  {GENRE_ADDON_PRESETS.map(g => {
                    const on = !!genreAddonOn[g.id];
                    return (
                      <button key={g.id} type="button" onClick={() => toggleGenreAddon(g.id)} style={honeOptionRow(on, true)}>
                        {on ? "✓ " : ""}{g.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                type="button"
                onClick={phoneOpenStreaming}
                aria-expanded={streamPhoneOpen}
                style={honeDropdownTrigger(true)}
              >
                <span style={{ fontFamily: "Georgia,serif", color: "#c8b99a" }}>
                  Streaming
                  {activeStreamDefs.length > 0 && (
                    <span style={{ fontFamily: "monospace", fontSize: 8, color: "rgba(200,169,110,0.95)", marginLeft: 6 }}>
                      {activeStreamDefs.length} on
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 8, color: "rgba(232,213,183,0.45)", flexShrink: 0 }}>{streamPhoneOpen ? "▴" : "▾"}</span>
              </button>
              {!honeKeywordsOpen && !honeGenresOpen && !streamPhoneOpen && tuningFetchLoading && tuningActive && (
                <p style={{ fontFamily: "monospace", fontSize: 7, color: "rgba(232,213,183,0.35)", margin: "4px 0 0" }}>Updating…</p>
              )}
              {streamPhoneOpen && (
                <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px solid rgba(232,213,183,0.06)" }}>
                  <p style={{ fontFamily: "monospace", fontSize: 7, color: "rgba(232,213,183,0.26)", margin: "0 0 5px", lineHeight: 1.3 }}>
                    NL / US · flatrate or rent
                  </p>
                  {tuningFetchLoading && tuningActive && (
                    <p style={{ fontFamily: "monospace", fontSize: 7, color: "rgba(232,213,183,0.38)", margin: "0 0 5px" }}>Fetching…</p>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {STREAMING_SERVICE_FILTERS.map(f => {
                      const on = !!streamFiltersOn[f.key];
                      return (
                        <button
                          key={f.key}
                          type="button"
                          onClick={() => toggleStreamFilter(f.key)}
                          style={{
                            ...S.streamFilterBtn,
                            padding: "5px 8px",
                            marginBottom: 3,
                            fontSize: 10,
                            ...(on ? S.streamFilterBtnOn : {}),
                            borderLeft: `3px solid ${on ? f.accent : "transparent"}`,
                          }}
                        >
                          {on ? "✓ " : ""}{f.label}
                        </button>
                      );
                    })}
                  </div>
                  {activeStreamDefs.length > 0 && (
                    <button type="button" onClick={clearStreamFilters} style={{ ...S.btn, fontSize: 8, padding: "4px 8px", marginTop: 5, width: "100%", opacity: 0.5 }}>
                      Clear streaming only
                    </button>
                  )}
                </div>
              )}
            </div>
            {tuningActive && (
              <button type="button" onClick={clearAllTuning} style={{ ...S.btn, fontSize: 8, padding: "5px 6px", marginTop: 6, width: "100%", opacity: 0.45 }}>
                Clear all filters
              </button>
            )}
          </div>
        ) : (
          <>
        <p style={S.resSidebarHeading}>Your session</p>

        {/* Mood summary */}
        <div style={S.resSidebarBlock}>
          <p style={S.resSidebarLabel}>Mood</p>
          <p style={{ fontFamily: "Georgia,serif", fontSize: 13, color: "#e8d5b7", margin: 0, fontStyle: "italic" }}>{moodLabel}</p>
        </div>

        {/* Viewer mode badge */}
        <div style={S.resSidebarBlock}>
          <p style={S.resSidebarLabel}>Watching as</p>
          <p style={{ fontFamily: "Georgia,serif", fontSize: 13, color: "#e8d5b7", margin: 0 }}>
            {VIEWER_MODES[viewerMode].emoji} {VIEWER_MODES[viewerMode].label}
          </p>
        </div>

        <div style={S.resSidebarDivider} />

        <div style={{ ...S.resSidebarBlock, paddingTop: 4 }}>
          <p style={S.resSidebarLabel}>Hone in</p>
          <p style={{ fontFamily: "monospace", fontSize: 8, color: "rgba(232,213,183,0.22)", margin: "0 0 8px", lineHeight: 1.4 }}>
            Optional — refetch with quiz + OR keywords / OR extra genres.
          </p>
          <button
            type="button"
            onClick={() => setHoneKeywordsOpen(v => !v)}
            aria-expanded={honeKeywordsOpen}
            style={honeDropdownTrigger(false)}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "rgba(232,213,183,0.38)" }}>
              Keywords
              {keywordIds.length > 0 && (
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(200,169,110,0.9)", marginLeft: 8 }}>
                  {keywordIds.length} on
                </span>
              )}
            </span>
            <span style={{ fontSize: 9, color: "rgba(232,213,183,0.45)" }}>{honeKeywordsOpen ? "▴" : "▾"}</span>
          </button>
          {honeKeywordsOpen && (
            <div style={{ marginBottom: 8 }}>
              {KEYWORD_HONE_PRESETS.map(kw => {
                const on = !!keywordOn[kw.id];
                return (
                  <button key={kw.id} type="button" onClick={() => toggleKeyword(kw.id)} style={honeOptionRow(on, false)}>
                    {on ? "✓ " : ""}{kw.label}
                  </button>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={() => setHoneGenresOpen(v => !v)}
            aria-expanded={honeGenresOpen}
            style={honeDropdownTrigger(false)}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "rgba(232,213,183,0.38)" }}>
              Genres
              {genreAddonIds.length > 0 && (
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(200,169,110,0.9)", marginLeft: 8 }}>
                  {genreAddonIds.length} on
                </span>
              )}
            </span>
            <span style={{ fontSize: 9, color: "rgba(232,213,183,0.45)" }}>{honeGenresOpen ? "▴" : "▾"}</span>
          </button>
          {honeGenresOpen && (
            <div style={{ marginBottom: 4 }}>
              {GENRE_ADDON_PRESETS.map(g => {
                const on = !!genreAddonOn[g.id];
                return (
                  <button key={g.id} type="button" onClick={() => toggleGenreAddon(g.id)} style={honeOptionRow(on, false)}>
                    {on ? "✓ " : ""}{g.label}
                  </button>
                );
              })}
            </div>
          )}
          {tuningActive && (
            <button type="button" onClick={clearAllTuning} style={{ ...S.btn, fontSize: 10, padding: "6px 8px", marginTop: 6, width: "100%", opacity: 0.55 }}>
              Clear all filters
            </button>
          )}
        </div>

        <div style={S.resSidebarDivider} />

        <div style={{ ...S.resSidebarBlock, paddingTop: 2 }}>
          <button
            type="button"
            onClick={() => setStreamSidebarOpen(o => !o)}
            aria-expanded={streamSidebarOpen}
            style={{
              ...S.btn,
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              fontSize: 11,
              padding: "6px 8px",
              textAlign: "left",
              marginBottom: 6,
              opacity: 0.88,
            }}
          >
            <span style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "rgba(232,213,183,0.38)" }}>
              Streaming
              {activeStreamDefs.length > 0 && (
                <span style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(200,169,110,0.9)", marginLeft: 8 }}>
                  {activeStreamDefs.length} on
                </span>
              )}
            </span>
            <span style={{ fontSize: 9, color: "rgba(232,213,183,0.45)" }}>{streamSidebarOpen ? "▴" : "▾"}</span>
          </button>
          {!streamSidebarOpen && tuningFetchLoading && tuningActive && (
            <p style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(232,213,183,0.38)", margin: "0 0 6px" }}>Updating picks…</p>
          )}
          {streamSidebarOpen && (
            <>
              <p style={{ fontFamily: "monospace", fontSize: 8, color: "rgba(232,213,183,0.22)", margin: "0 0 8px", lineHeight: 1.4 }}>
                Optional — limit to services you use (NL / US, flatrate or rent). Verified on cards.
              </p>
              {tuningFetchLoading && tuningActive && (
                <p style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(232,213,183,0.45)", margin: "0 0 8px" }}>Fetching…</p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {STREAMING_SERVICE_FILTERS.map(f => {
                  const on = !!streamFiltersOn[f.key];
                  return (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => toggleStreamFilter(f.key)}
                      style={{
                        ...S.streamFilterBtn,
                        ...(on ? S.streamFilterBtnOn : {}),
                        borderLeft: `3px solid ${on ? f.accent : "transparent"}`,
                      }}
                    >
                      {on ? "✓ " : ""}{f.label}
                    </button>
                  );
                })}
              </div>
              {activeStreamDefs.length > 0 && (
                <button type="button" onClick={clearStreamFilters} style={{ ...S.btn, fontSize: 10, padding: "6px 8px", marginTop: 8, width: "100%", opacity: 0.55 }}>
                  Clear streaming only
                </button>
              )}
            </>
          )}
        </div>

        <div style={S.resSidebarDivider} />

        {/* Stats */}
        <div style={S.resSidebarBlock}>
          <p style={S.resSidebarLabel}>Results</p>
          <p style={{ fontFamily: "monospace", fontSize: 11, color: "rgba(232,213,183,0.5)", margin: 0 }}>
            {`${movies.length} picks`}
            {moreMovies.length > 0 ? ` + ${moreMovies.length} more` : ""}
          </p>
        </div>
          </>
        )}
      </div>

      {/* ── Main results ── (first on phone so picks lead) */}
      <div style={{ ...S.resultsWrap, gap: isNarrow ? 16 : S.resultsWrap.gap, order: isPhone ? 1 : 0, minWidth: 0 }}>
        <div style={{ marginBottom: 8 }}>
          <h2 style={{ ...S.title, fontSize: "clamp(20px,3vw,28px)", margin: 0 }}>Your FlickMatch</h2>
          <p style={S.subtitle}>
            {tuningActive
              ? `Refined for ${moodLabel} — quiz answers + your hone-ins${activeStreamDefs.length ? " · streaming" : ""}`
              : `For your ${moodLabel} mood`}
          </p>
          {tuningFetchLoading && tuningActive && (
            <p style={{ fontFamily: "monospace", fontSize: 9, color: "rgba(232,213,183,0.4)", margin: "6px 0 0", letterSpacing: "0.5px" }}>
              Refetching discover…
            </p>
          )}
        </div>

        {!tuningFetchLoading && movies.length === 0 && moreMovies.length === 0 ? (
          <div style={{ ...S.card, padding: 20, textAlign: "center" }}>
            <p style={{ fontFamily: "Georgia,serif", fontSize: 14, color: "#e8d5b7", margin: 0 }}>
              Nothing turned up for that combo (mood + hone-ins + streaming).
            </p>
            <p style={{ fontFamily: "Georgia,serif", fontSize: 12, color: "rgba(232,213,183,0.45)", margin: "10px 0 0" }}>
              Mood + keywords + genres must all match TMDB discover together — some combos are very tight. Remove a chip, try another keyword, or clear hone-ins for baseline picks.
            </p>
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, opacity: tuningFetchLoading && tuningActive ? 0.45 : 1 }}>
              {movies.map((m, i) => (
                <MovieCard key={m.id} movie={m} index={i} answers={answers} isBestMatch={i === 0} isNarrow={isNarrow} />
              ))}
            </div>

            {moreMovies.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, opacity: tuningFetchLoading && tuningActive ? 0.45 : 1 }}>
                <div style={S.moreDivider}>
                  <span style={S.moreDividerLabel}>more picks</span>
                </div>
                {moreMovies.map(m => (
                  <MiniCard key={m.id} movie={m} answers={answers} isNarrow={isNarrow} />
                ))}
              </div>
            )}
          </>
        )}

        {/* Bottom controls (requested): More picks + Adjust */}
        <div style={{ marginTop: 10, paddingTop: 14, borderTop: "1px solid rgba(232,213,183,0.08)", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: isPhone ? "column" : "row", gap: 10 }}>
            <button
              onClick={handleLoadMorePicks}
              disabled={loadingMore || loadMoreExhausted}
              style={{ ...S.btn, fontSize: 12, padding: "10px 14px", opacity: loadingMore || loadMoreExhausted ? 0.5 : 1, width: isPhone ? "100%" : "auto", flex: 1 }}
            >
              {loadingMore
                ? "Loading…"
                : loadMoreExhausted
                  ? "No more picks right now"
                  : moreMovies.length > 0
                    ? "Load more picks →"
                    : "Show more picks →"}
            </button>
            <button
              onClick={onRefine}
              style={{ ...S.btn, fontSize: 12, padding: "10px 14px", width: isPhone ? "100%" : "auto", flex: 1 }}
            >
              Different angle
            </button>
          </div>
          <button
            onClick={onReset}
            style={{ ...S.btn, fontSize: 11, padding: "9px 14px", opacity: 0.35, width: "100%" }}
          >
            Start over
          </button>
        </div>
      </div>

    </div>
  );
}

function MovieCard({ movie, index, answers, isBestMatch, isNarrow }) {
  const [imdbId, setImdbId] = useState(null);

  useEffect(() => {
    tmdb.externalIds(movie.id)
      .then(d => { if (d?.imdb_id) setImdbId(d.imdb_id); })
      .catch(() => {});
  }, [movie.id]);

  const poster = movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null;
  const year = movie.release_date?.slice(0, 4) || "";
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "";
  const lbSlug = movie.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const tags = getMoodTags(movie, answers);
  const whyWatch = getWhyWatch(movie, answers, index);

  return (
    <div style={{ ...S.card, ...(isBestMatch ? S.cardBest : {}), flexDirection: isNarrow ? "column" : "row" }}>
      {isBestMatch && <div style={S.bestBadge}>Best match</div>}

      <div style={{ position: "relative", flexShrink: 0 }}>
        {poster ? (
          <img
            src={poster}
            alt={movie.title}
            style={{ ...S.poster, width: isNarrow ? "100%" : S.poster.width, height: isNarrow ? 240 : S.poster.height }}
          />
        ) : (
          <div style={{ ...S.posterFb, width: isNarrow ? "100%" : S.posterFb.width, height: isNarrow ? 240 : S.posterFb.height }}>🎬</div>
        )}
        <div style={{ ...S.num, background: isBestMatch ? "#c8a96e" : "#e8d5b7" }}>{index + 1}</div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 9 }}>
        {/* Title + meta */}
        <div>
          <h3 style={{ ...S.movieTitle, fontSize: isBestMatch ? 19 : 17 }}>{movie.title}</h3>
          <p style={S.meta}>
            {year}
            {rating ? <span style={{ color: Number(rating) >= 7.5 ? "#c8a96e" : "rgba(232,213,183,0.5)" }}> · ★ {rating}</span> : ""}
            {movie.vote_count ? ` · ${(movie.vote_count / 1000).toFixed(0)}K votes` : ""}
          </p>
        </div>

        {/* Tags */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {tags.map(tag => <span key={tag} style={S.tag}>{tag}</span>)}
        </div>

        {/* Why watch */}
        <p style={S.whyWatch}>{whyWatch}</p>

        {/* Overview */}
        {movie.overview && (
          <p style={S.overview}>{movie.overview.length > 120 ? movie.overview.slice(0, 120) + "…" : movie.overview}</p>
        )}

        {/* Two-column bottom: where to watch | review links */}
        <div style={{ ...S.cardFooter, flexDirection: isNarrow ? "column" : S.cardFooter.flexDirection, gap: isNarrow ? 12 : S.cardFooter.gap }}>
          <div style={S.cardFooterCol}>
            <p style={S.footerLabel}>Where to watch</p>
            <WatchProviders movieId={movie.id} />
          </div>
          {!isNarrow && <div style={S.cardFooterDivider} />}
          <div style={S.cardFooterCol}>
            <p style={S.footerLabel}>More info</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {imdbId && (
                <a href={`https://www.imdb.com/title/${imdbId}`} target="_blank" rel="noopener noreferrer" style={S.infoLink}>
                  <span style={S.infoLinkIcon}>⭐</span> IMDb
                </a>
              )}
              <a href={`https://letterboxd.com/film/${lbSlug}`} target="_blank" rel="noopener noreferrer" style={{ ...S.infoLink, ...S.infoLinkGreen }}>
                <span style={S.infoLinkIcon}>🎞</span> Letterboxd
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Mini card for "show more" grid ──────────────────────────────────────────
function MiniCard({ movie, answers, isNarrow }) {
  const [imdbId, setImdbId] = useState(null);

  useEffect(() => {
    tmdb.externalIds(movie.id)
      .then(d => { if (d?.imdb_id) setImdbId(d.imdb_id); })
      .catch(() => {});
  }, [movie.id]);

  const poster = movie.poster_path ? `https://image.tmdb.org/t/p/w342${movie.poster_path}` : null;
  const rating = movie.vote_average ? movie.vote_average.toFixed(1) : "";
  const year = movie.release_date?.slice(0, 4) || "";
  const lbSlug = movie.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const tags = getMoodTags(movie, answers).slice(0, 3);

  return (
    <div style={{ ...S.miniCard, flexDirection: isNarrow ? "column" : "row" }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        {poster
          ? <img src={poster} alt={movie.title} style={{ ...S.miniPoster, width: isNarrow ? "100%" : S.miniPoster.width, height: isNarrow ? 220 : S.miniPoster.height }} />
          : <div style={{ ...S.miniPoster, width: isNarrow ? "100%" : S.miniPoster.width, height: isNarrow ? 220 : S.miniPoster.height, background: "rgba(232,213,183,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎬</div>
        }
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div>
          <p style={S.miniTitle}>{movie.title}</p>
          <p style={{ ...S.meta, margin: "3px 0 0", fontSize: 10 }}>
            {year}
            {rating ? <span style={{ color: Number(rating) >= 7.5 ? "#c8a96e" : "rgba(232,213,183,0.45)" }}> · ★ {rating}</span> : ""}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {tags.map(t => <span key={t} style={{ ...S.tag, fontSize: 9, padding: "2px 6px" }}>{t}</span>)}
        </div>
        {/* Two-column footer: providers | links */}
        <div style={{ ...S.cardFooter, flexDirection: isNarrow ? "column" : S.cardFooter.flexDirection, gap: isNarrow ? 10 : 10, marginTop: 2 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ ...S.footerLabel, fontSize: 8 }}>Stream / Rent</p>
            <WatchProviders movieId={movie.id} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 }}>
            {imdbId && (
              <a href={`https://www.imdb.com/title/${imdbId}`} target="_blank" rel="noopener noreferrer" style={{ ...S.infoLink, fontSize: 10 }}>
                ⭐ IMDb
              </a>
            )}
            <a href={`https://letterboxd.com/film/${lbSlug}`} target="_blank" rel="noopener noreferrer" style={{ ...S.infoLink, ...S.infoLinkGreen, fontSize: 10 }}>
              🎞 Letterboxd
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Grain() {
  return <div style={S.grain} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  root: { minHeight: "100vh", background: "#0d0b09", display: "flex", flexDirection: "column", alignItems: "stretch", position: "relative" },
  grain: { position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E")` },
  center: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 1 },
  title: { fontFamily: "Georgia,'Times New Roman',serif", fontSize: "clamp(24px,5vw,40px)", color: "#e8d5b7", margin: 0, fontWeight: 400 },
  subtitle: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.45)", fontSize: 15, margin: "8px 0 0", fontStyle: "italic" },
  btn: { background: "transparent", border: "1px solid rgba(232,213,183,0.35)", color: "#e8d5b7", padding: "12px 26px", fontFamily: "Georgia,serif", fontSize: 14, cursor: "pointer", zIndex: 1, transition: "all 0.2s" },

  qLayout: { display: "flex", gap: 48, alignItems: "flex-start", zIndex: 1, width: "100%", maxWidth: 960, padding: "0 8px" },
  qPanel: { flex: "0 0 420px", maxWidth: "420px" },
  previewPanel: { flex: 1, minWidth: 0, paddingTop: 8 },
  previewLabel: { fontFamily: "monospace", color: "rgba(232,213,183,0.22)", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase", margin: "0 0 14px" },
  posterGrid: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
  thumbWrap: { position: "relative", aspectRatio: "2/3", overflow: "hidden", cursor: "pointer" },
  thumb: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbOverlay: { position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 55%)", display: "flex", alignItems: "flex-end", padding: "6px 5px" },
  thumbTitle: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.85)", fontSize: 9, lineHeight: 1.3, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  posterPlaceholder: { aspectRatio: "2/3", background: "rgba(232,213,183,0.03)", border: "1px solid rgba(232,213,183,0.05)" },
  thumbHoverOverlay: { position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, padding: "7px 5px" },
  thumbHoverTitle: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.9)", fontSize: 9, lineHeight: 1.3, textAlign: "center", marginBottom: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  linkBtn: { display: "block", width: "100%", padding: "4px 0", textAlign: "center", fontFamily: "monospace", fontSize: 8, letterSpacing: "0.5px", textDecoration: "none", background: "rgba(232,213,183,0.12)", border: "1px solid rgba(232,213,183,0.25)", color: "rgba(232,213,183,0.85)" },
  linkBtnGreen: { background: "rgba(0,180,90,0.15)", border: "1px solid rgba(0,200,100,0.3)", color: "rgba(160,240,180,0.9)" },

  qCounter: { fontFamily: "monospace", color: "rgba(232,213,183,0.28)", fontSize: 11, letterSpacing: "2px", margin: "0 0 12px" },
  qText: { fontFamily: "Georgia,serif", color: "#e8d5b7", fontSize: "clamp(18px,2.5vw,26px)", fontWeight: 400, margin: "0 0 24px", lineHeight: 1.35 },
  grid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 },
  optBtn: { background: "rgba(232,213,183,0.03)", border: "1px solid rgba(232,213,183,0.1)", color: "#e8d5b7", padding: "14px 10px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 7, transition: "all 0.18s", fontFamily: "Georgia,serif" },
  optSelected: { background: "rgba(232,213,183,0.1)", border: "1px solid rgba(232,213,183,0.45)", transform: "scale(0.97)" },

  resultsWrap: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 20, width: "100%" },
  card: { position: "relative", display: "flex", gap: 18, background: "rgba(232,213,183,0.025)", border: "1px solid rgba(232,213,183,0.08)", padding: 14, alignItems: "flex-start", transition: "border-color 0.2s, background 0.2s", cursor: "default" },
  cardBest: { border: "1px solid rgba(200,169,110,0.3)", background: "rgba(200,169,110,0.04)" },
  cardHovered: { background: "rgba(232,213,183,0.055)", border: "1px solid rgba(232,213,183,0.22)" },
  bestBadge: { position: "absolute", top: -1, right: 12, fontFamily: "monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase", color: "#c8a96e", background: "#0d0b09", padding: "0 6px", lineHeight: "18px", border: "1px solid rgba(200,169,110,0.3)", borderTop: "none" },
  poster: { width: 76, height: 114, objectFit: "cover", display: "block" },
  posterFb: { width: 76, height: 114, background: "rgba(232,213,183,0.05)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 },
  num: { position: "absolute", top: -7, left: -7, width: 20, height: 20, background: "#e8d5b7", color: "#0d0b09", fontSize: 10, fontFamily: "monospace", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold" },
  movieTitle: { fontFamily: "Georgia,serif", color: "#e8d5b7", fontWeight: 400, margin: 0 },
  meta: { fontFamily: "monospace", color: "rgba(232,213,183,0.35)", fontSize: 11, margin: "4px 0 0", letterSpacing: "0.5px" },
  overview: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.55)", fontSize: 13, margin: 0, lineHeight: 1.5 },
  tagline: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.38)", fontSize: 12, margin: "auto 0 0", fontStyle: "italic" },
  cardLinkBtn: { display: "inline-flex", alignItems: "center", padding: "6px 12px", fontFamily: "monospace", fontSize: 11, letterSpacing: "1px", textDecoration: "none", background: "rgba(232,213,183,0.08)", border: "1px solid rgba(232,213,183,0.25)", color: "rgba(232,213,183,0.85)", transition: "all 0.15s" },
  cardLinkBtnGreen: { background: "rgba(0,180,90,0.1)", border: "1px solid rgba(0,200,100,0.3)", color: "rgba(160,240,180,0.9)" },

  // Card footer two-column layout
  cardFooter: { display: "flex", gap: 16, marginTop: 4, paddingTop: 10, borderTop: "1px solid rgba(232,213,183,0.07)", alignItems: "flex-start" },
  cardFooterCol: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  cardFooterDivider: { width: 1, alignSelf: "stretch", background: "rgba(232,213,183,0.07)", flexShrink: 0 },
  footerLabel: { fontFamily: "monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(232,213,183,0.28)", margin: "0 0 6px" },

  // Info links (IMDb / Letterboxd) — always visible, no hover needed
  infoLink: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", fontFamily: "Georgia,serif", fontSize: 12, textDecoration: "none", background: "rgba(232,213,183,0.06)", border: "1px solid rgba(232,213,183,0.14)", color: "rgba(232,213,183,0.75)", transition: "all 0.15s", whiteSpace: "nowrap" },
  infoLinkGreen: { background: "rgba(0,160,80,0.08)", border: "1px solid rgba(0,200,100,0.2)", color: "rgba(140,230,170,0.8)" },
  infoLinkIcon: { fontSize: 13 },

  // Viewer mode selector
  modeBtn: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 18px", fontFamily: "Georgia,serif", fontSize: 12, color: "rgba(232,213,183,0.5)", background: "transparent", border: "1px solid rgba(232,213,183,0.1)", cursor: "pointer", transition: "all 0.18s", minWidth: 90 },
  modeBtnActive: { color: "#e8d5b7", background: "rgba(232,213,183,0.07)", border: "1px solid rgba(232,213,183,0.35)" },

  // Top bar
  topBar: { position: "sticky", top: 0, zIndex: 100, display: "flex", alignItems: "center", gap: 20, padding: "0 24px", height: 52, background: "#0d0b09", borderBottom: "1px solid rgba(232,213,183,0.1)", flexShrink: 0, overflow: "visible" },
  topBarLogo: { fontFamily: "Georgia,'Times New Roman',serif", fontSize: 15, color: "#e8d5b7", textDecoration: "none", display: "flex", alignItems: "center", gap: 7, flexShrink: 0, letterSpacing: "-0.3px", fontWeight: 400 },
  // NOTE: avoid overflow containers here; they clip absolutely-positioned dropdowns in many browsers
  // (when one axis is non-visible, the other axis may become non-visible as well).
  topBarTimeline: { display: "flex", alignItems: "center", gap: 3, flex: 1, position: "relative", flexWrap: "wrap", overflow: "visible" },
  topBarSep: { width: 1, height: 18, background: "rgba(232,213,183,0.15)", flexShrink: 0, margin: "0 6px" },
  topBarArrow: { color: "rgba(232,213,183,0.3)", fontSize: 13, flexShrink: 0, userSelect: "none", marginTop: 1 },
  topBarPill: { display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", fontFamily: "Georgia,serif", fontSize: 12, color: "#c8b99a", background: "rgba(232,213,183,0.07)", border: "1px solid rgba(232,213,183,0.14)", cursor: "pointer", whiteSpace: "nowrap", transition: "all 0.15s", borderRadius: 3, lineHeight: 1 },
  topBarPillMode: { color: "#e8d5b7", background: "rgba(232,213,183,0.11)", border: "1px solid rgba(232,213,183,0.25)", fontWeight: 400 },
  topBarPillOpen: { background: "rgba(232,213,183,0.14)", border: "1px solid rgba(232,213,183,0.35)", color: "#e8d5b7" },
  topBarChevron: { fontSize: 9, color: "rgba(232,213,183,0.4)", marginLeft: 3 },
  topBarDropdown: { position: "absolute", top: "calc(100% + 8px)", left: 0, minWidth: 220, background: "#1a1712", border: "1px solid rgba(232,213,183,0.22)", zIndex: 500, display: "flex", flexDirection: "column", boxShadow: "0 16px 40px rgba(0,0,0,0.85)" },
  topBarDropLabel: { fontFamily: "monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(232,213,183,0.4)", padding: "10px 14px 6px", margin: 0, borderBottom: "1px solid rgba(232,213,183,0.09)" },
  topBarDropItem: { display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", fontFamily: "Georgia,serif", fontSize: 13, color: "#c8b99a", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", transition: "background 0.12s", width: "100%" },
  topBarDropItemActive: { color: "#e8d5b7", background: "rgba(232,213,183,0.09)" },

  // Results two-column layout — alignItems flex-start so sidebar height ≠ main column (required for sticky).
  resultsLayout: { display: "flex", gap: 28, alignItems: "flex-start", zIndex: 1, width: "100%", maxWidth: 1020, padding: "32px 8px" },

  // Results sidebar: sticky under top bar; internal scroll if many filters
  resSidebar: { flexShrink: 0, width: 208, position: "sticky", top: 60, alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: 0, maxHeight: "calc(100vh - 68px)", overflowY: "auto", zIndex: 2, paddingRight: 4 },
  streamFilterBtn: { display: "block", width: "100%", padding: "6px 8px", marginBottom: 5, fontFamily: "Georgia,serif", fontSize: 11, textAlign: "left", cursor: "pointer", borderRadius: 3, border: "1px solid rgba(232,213,183,0.12)", background: "rgba(232,213,183,0.03)", color: "rgba(232,213,183,0.45)", transition: "all 0.15s" },
  streamFilterBtnOn: { color: "#e8d5b7", background: "rgba(232,213,183,0.08)", borderColor: "rgba(232,213,183,0.35)" },
  resSidebarHeading: { fontFamily: "monospace", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", color: "rgba(232,213,183,0.25)", margin: "0 0 12px" },
  resSidebarBlock: { padding: "10px 0", display: "flex", flexDirection: "column", gap: 7 },
  resSidebarLabel: { fontFamily: "monospace", fontSize: 8, letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(232,213,183,0.3)", margin: 0 },
  resSidebarDivider: { height: 1, background: "rgba(232,213,183,0.07)", margin: "2px 0" },
  sidebarWrap: { flexShrink: 0, width: 200, position: "sticky", top: 24 },

  // Sidebar
  sidebar: { display: "flex", flexDirection: "column", gap: 0 },
  sidebarHeading: { fontFamily: "monospace", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", color: "rgba(232,213,183,0.25)", margin: "0 0 14px" },
  sidebarRow: { display: "flex", flexDirection: "column" },
  sidebarItem: { display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", cursor: "pointer", border: "1px solid rgba(232,213,183,0.06)", borderBottom: "none", background: "rgba(232,213,183,0.02)", transition: "background 0.15s" },
  sidebarLabel: { fontFamily: "monospace", fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase", color: "rgba(232,213,183,0.3)" },
  sidebarValue: { fontFamily: "Georgia,serif", fontSize: 12, color: "rgba(232,213,183,0.8)", display: "flex", alignItems: "center", justifyContent: "space-between" },
  sidebarChevron: { fontSize: 9, color: "rgba(232,213,183,0.3)", transition: "transform 0.18s", marginLeft: 4 },
  sidebarOptions: { display: "flex", flexDirection: "column", background: "rgba(232,213,183,0.04)", border: "1px solid rgba(232,213,183,0.1)", borderTop: "none", marginBottom: 2 },
  sidebarOpt: { display: "flex", alignItems: "center", gap: 7, padding: "7px 10px", fontFamily: "Georgia,serif", fontSize: 11, color: "rgba(232,213,183,0.6)", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", transition: "all 0.15s" },
  sidebarOptActive: { color: "#e8d5b7", background: "rgba(232,213,183,0.07)" },

  // Mood tags
  tag: { display: "inline-block", fontFamily: "monospace", fontSize: 10, letterSpacing: "0.5px", color: "rgba(232,213,183,0.55)", background: "rgba(232,213,183,0.06)", border: "1px solid rgba(232,213,183,0.1)", padding: "2px 7px" },

  // Why watch
  whyWatch: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.6)", fontSize: 12, margin: 0, fontStyle: "italic", lineHeight: 1.5 },

  // Show more section
  moreDivider: { display: "flex", alignItems: "center", gap: 12, margin: "4px 0" },
  moreDividerLabel: { fontFamily: "monospace", fontSize: 9, letterSpacing: "2px", textTransform: "uppercase", color: "rgba(232,213,183,0.22)", whiteSpace: "nowrap" },
  moreGrid: { display: "flex", flexDirection: "column", gap: 10 },

  // Mini card
  miniCard: { display: "flex", gap: 12, background: "rgba(232,213,183,0.02)", border: "1px solid rgba(232,213,183,0.06)", padding: "10px 12px", alignItems: "flex-start", transition: "all 0.18s", cursor: "default" },
  miniCardHovered: { background: "rgba(232,213,183,0.04)", border: "1px solid rgba(232,213,183,0.15)" },
  miniPoster: { width: 44, height: 66, objectFit: "cover", display: "block" },
  miniTitle: { fontFamily: "Georgia,serif", color: "rgba(232,213,183,0.85)", fontSize: 13, fontWeight: 400, margin: 0, lineHeight: 1.3 },
};
