/* Classifier for Smart Window auto grouping (extension prototype).
 *
 * Two backends, picked at runtime:
 *   - "model": on-device sentence embeddings through Firefox's trial.ml API
 *     (needs the optional "trialML" permission, granted from the popup).
 *   - "heuristic": domain + title-keyword rules. Always available; also the
 *     fallback whenever the model is not ready.
 *
 * Exposes a single global `Classifier` used by background.js.
 */
/* global browser */

const Classifier = (() => {
  // Same model, hub, revision and dtype as Nightly's shared "contextual"
  // embeddings generator (Remote Settings feature "simple-text-embedder"),
  // which the in-tree smart tab grouping uses for clustering. Key order
  // matters: modelRevision must follow modelHub or the hub default wins.
  const MODEL = {
    taskName: "feature-extraction",
    modelHub: "mozilla",
    modelId: "Xenova/all-MiniLM-L6-v2",
    modelRevision: "v0.1.0",
    dtype: "q8",
  };

  // Label table. `keys` drive the heuristic; `proto` is embedded for the model.
  const CATEGORIES = [
    { label: "Travel", color: "blue", proto: "travel: flights, hotels, trip planning, destinations and sightseeing",
      keys: ["travel", "flight", "flights", "hotel", "hotels", "booking", "airbnb", "trip", "itinerary", "airline", "expedia", "kayak", "tripadvisor", "wikivoyage", "vacation", "holiday", "tourism", "things to do", "lonely planet", "hostel", "airport", "visa"] },
    { label: "Recipes", color: "orange", proto: "cooking and baking recipes with ingredients and instructions",
      keys: ["recipe", "recipes", "cook", "cooking", "bake", "baking", "ingredients", "allrecipes", "cookbook", "kitchen", "dinner", "dessert", "food52", "epicurious", "seriouseats", "bon appetit", "meal",
             "pancake", "waffle", "crêpe", "crepe", "cookie", "cookies", "bread", "cake", "pie", "soup", "salad", "pasta", "sauce", "curry", "stew", "roast", "grill", "sourdough", "brownie", "muffin"] },
    { label: "Shopping", color: "pink", proto: "online shopping, product listings, prices and carts",
      keys: ["amazon", "cart", "buy", "price", "ebay", "etsy", "shop", "store", "deal", "checkout", "order", "walmart", "target.com", "bestbuy", "zalando", "wayfair"] },
    { label: "News", color: "red", proto: "news articles and current events",
      keys: ["news", "nytimes", "bbc", "guardian", "reuters", "washingtonpost", "cnn", "apnews", "bloomberg", "politics", "breaking"] },
    { label: "Dev", color: "purple", proto: "software development, code, documentation, bugs and APIs",
      keys: ["github", "stack overflow", "stackoverflow", "docs", "mdn", "bugzilla", "api", "npm", "pypi", "developer", "sdk", "gitlab", "phabricator", "searchfox", "rust", "python", "javascript", "typescript", "compiler", "error"] },
    { label: "Video", color: "cyan", proto: "watching videos, streaming shows and films",
      keys: ["youtube", "netflix", "video", "watch", "twitch", "vimeo", "hulu", "disney+", "prime video", "episode", "trailer"] },
    { label: "Social", color: "green", proto: "social media feeds, posts and discussions",
      keys: ["reddit", "twitter", "x.com", "mastodon", "bluesky", "facebook", "instagram", "linkedin", "threads", "tiktok", "discord"] },
    { label: "Finance", color: "green", proto: "personal finance, banking, investing and stocks",
      keys: ["bank", "stock", "stocks", "invest", "investing", "finance", "mortgage", "tax", "taxes", "crypto", "etf", "401k", "budget", "credit card", "nasdaq", "s&p"] },
    { label: "Health", color: "yellow", proto: "health, medicine, fitness and wellbeing",
      keys: ["health", "doctor", "symptom", "symptoms", "medical", "fitness", "workout", "nutrition", "mayo clinic", "webmd", "nih", "therapy", "sleep"] },
    { label: "Sports", color: "orange", proto: "sports scores, teams, matches and athletes",
      keys: ["espn", "score", "scores", "match", "league", "nba", "nfl", "mlb", "nhl", "fifa", "premier league", "tennis", "golf", "olympics", "world cup"] },
    { label: "Music", color: "purple", proto: "music, songs, albums, artists and playlists",
      keys: ["spotify", "music", "album", "playlist", "bandcamp", "soundcloud", "lyrics", "concert", "tickets", "song"] },
    { label: "Research", color: "blue", proto: "research papers, encyclopedia articles and reference material",
      keys: ["wikipedia", "arxiv", "scholar", "paper", "study", "journal", "research", "pubmed", "jstor", "encyclopedia", "doi.org"] },
    { label: "Work", color: "grey", proto: "work documents, project tracking, meetings and team tools",
      keys: ["docs.google", "sheets.google", "slides.google", "notion", "jira", "confluence", "slack", "asana", "trello", "figma", "zoom", "meet.google", "calendar", "drive.google", "mozilla.atlassian"] },
    { label: "Mail", color: "grey", proto: "email inbox and messages",
      keys: ["mail.google", "gmail", "outlook", "inbox", "mail.", "proton.me", "fastmail"] },
    { label: "Maps", color: "cyan", proto: "maps, directions and places",
      keys: ["maps", "directions", "map", "openstreetmap", "waze", "route"] },
    { label: "Jobs", color: "yellow", proto: "job listings, careers and hiring",
      keys: ["jobs", "job", "careers", "hiring", "indeed", "glassdoor", "lever.co", "greenhouse.io", "resume", "interview"] },
    { label: "Housing", color: "green", proto: "homes for sale or rent, apartments and real estate",
      keys: ["zillow", "redfin", "realtor", "apartment", "apartments", "rent", "real estate", "for sale", "house", "homes", "idealista", "rightmove"] },
    { label: "Cars", color: "red", proto: "cars, vehicles, dealers and auto reviews",
      keys: ["car", "cars", "vehicle", "tesla", "toyota", "honda", "autotrader", "cargurus", "dealer", "ev", "suv"] },
    { label: "Learning", color: "blue", proto: "courses, tutorials, lessons and studying",
      keys: ["course", "courses", "tutorial", "lesson", "learn", "coursera", "udemy", "khan academy", "edx", "duolingo", "exam", "syllabus"] },
    { label: "Gaming", color: "purple", proto: "video games, consoles and gaming news",
      keys: ["game", "games", "steam", "playstation", "xbox", "nintendo", "ign", "gamespot", "walkthrough", "esports"] },
  ];

  const COLORS = ["blue", "cyan", "grey", "green", "orange", "pink", "purple", "red", "yellow"];
  const STOP = new Set("the a an and or of to in on for with by at from is are be this that it its as into your you how what why when where which best top new free online official home page site www com org net".split(" "));

  // ---- model state -------------------------------------------------------
  let engineReady = false;
  let enginePromise = null;
  let protoVecs = null;
  let modelStatus = { backend: "heuristic", detail: "On-device model not enabled", progress: null };
  const vecCache = new Map();

  if (browser.trial?.ml?.onProgress) {
    try {
      browser.trial.ml.onProgress.addListener(data => {
        if (data && typeof data.progress === "number") {
          modelStatus.progress = Math.round(data.progress);
          modelStatus.detail = `Downloading model ${modelStatus.progress}%`;
        }
      });
    } catch (e) {
      // Listener registration can throw before the permission is granted.
    }
  }

  async function hasModelPermission() {
    try {
      return await browser.permissions.contains({ permissions: ["trialML"] });
    } catch (e) {
      return false;
    }
  }

  async function ensureEngine() {
    if (engineReady) {
      return true;
    }
    if (!enginePromise) {
      enginePromise = (async () => {
        if (!(await hasModelPermission())) {
          modelStatus = { backend: "heuristic", detail: "On-device model not enabled", progress: null };
          enginePromise = null; // retry once the popup grants the permission
          return false;
        }
        if (!browser.trial?.ml) {
          modelStatus = { backend: "heuristic", detail: "trial.ml API unavailable in this Firefox", progress: null };
          enginePromise = null;
          return false;
        }
        try {
          modelStatus = { backend: "heuristic", detail: "Loading model…", progress: null };
          await browser.trial.ml.createEngine(MODEL);
          protoVecs = await embed(CATEGORIES.map(c => c.proto));
          engineReady = true;
          modelStatus = { backend: "model", detail: `On-device model ready (${MODEL.modelId} ${MODEL.modelRevision}, Mozilla hub)`, progress: 100 };
          return true;
        } catch (e) {
          console.warn("[auto-grouping] model engine failed, using heuristic:", e);
          modelStatus = { backend: "heuristic", detail: `Model failed: ${e.message}`, progress: null };
          enginePromise = null; // allow a retry from the popup
          return false;
        }
      })();
    }
    return enginePromise;
  }

  function toRows(result, n) {
    if (Array.isArray(result) && result.length === n && Array.isArray(result[0])) {
      return result;
    }
    if (Array.isArray(result) && result[0] && result[0].data) {
      return result.map(r => Array.from(r.data));
    }
    const data = result && result.data ? result.data : result;
    const flat = Array.from(data);
    const dims = result && result.dims;
    const dim = dims ? dims[dims.length - 1] : Math.floor(flat.length / n);
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push(flat.slice(i * dim, (i + 1) * dim));
    }
    return rows;
  }

  async function embed(texts) {
    const missing = texts.filter(t => !vecCache.has(t));
    if (missing.length) {
      const result = await browser.trial.ml.runEngine({
        args: [missing],
        options: { pooling: "mean", normalize: true, max_length: 100 },
      });
      const rows = toRows(result, missing.length);
      missing.forEach((t, i) => vecCache.set(t, rows[i]));
    }
    return texts.map(t => vecCache.get(t));
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
  }

  function centroid(vecs) {
    const out = new Array(vecs[0].length).fill(0);
    for (const v of vecs) {
      for (let i = 0; i < v.length; i++) {
        out[i] += v[i];
      }
    }
    return out.map(x => x / vecs.length);
  }

  // ---- text helpers --------------------------------------------------------
  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function siteOf(url) {
    const host = hostOf(url);
    const parts = host.split(".");
    if (parts.length <= 2) {
      return host;
    }
    const sld = parts[parts.length - 2];
    const twoLevel = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
    return twoLevel.has(sld) ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
  }

  // Title with the trailing site-name boilerplate removed ("Pancake - Wikipedia" → "Pancake").
  function cleanTitle(tab) {
    const raw = (tab.title || "").replace(/\s+/g, " ").trim();
    const parts = raw.split(/\s+[-–—|·:]\s+|\s+\|\s+/).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const host = hostOf(tab.url).toLowerCase();
      const site = host.split(".").filter(p => !["www", "en", "m", "simple"].includes(p))[0] || "";
      // Drop segments that just name the site, from the end.
      while (parts.length > 1) {
        const last = parts[parts.length - 1].toLowerCase();
        const looksLikeSite = (site && (last.includes(site) || site.includes(last.replace(/\W/g, ""))))
          || /wikipedia|wikibooks|wikivoyage|encyclopedia|open books/.test(last)
          || last.split(" ").length <= 4 && parts.length > 1 && last.length < 40 && parts.indexOf(parts[parts.length - 1]) === parts.length - 1 && /^[A-Z]/.test(parts[parts.length - 1]) && raw.length > 25;
        if (!looksLikeSite) {
          break;
        }
        parts.pop();
      }
    }
    // Wikibooks "Cookbook:Pancakes" style prefixes carry the topic; keep both words.
    return parts.join(" ").replace(/^Cookbook:/i, "Cookbook ").trim() || raw;
  }

  // Text the model embeds: the title with site boilerplate stripped, as the
  // in-tree preprocessText does (the tree also appends a page description,
  // which an extension cannot read without content scripts).
  function textOf(tab) {
    if (!tab.url) {
      return (tab.title || "").trim();
    }
    return cleanTitle(tab) || "Unknown";
  }

  function tokens(text) {
    return new Set(
      text.toLowerCase().split(/[^\p{L}\p{N}+#]+/u).filter(t => t.length > 2 && !STOP.has(t))
    );
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) {
      return 0;
    }
    let inter = 0;
    for (const t of a) {
      if (b.has(t)) {
        inter++;
      }
    }
    return inter / (a.size + b.size - inter);
  }

  // Title words count double; the URL (host boilerplate like "wikipedia") is a weak hint.
  function categoryOf(tab) {
    const title = cleanTitle(tab).toLowerCase();
    const url = (tab.url || "").toLowerCase();
    let best = null, bestScore = 0;
    for (const c of CATEGORIES) {
      let score = 0;
      for (const k of c.keys) {
        if (title.includes(k)) {
          score += 2;
        } else if (url.includes(k)) {
          score += 1;
        }
      }
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    return best;
  }

  // Heuristic similarity in [0, 1].
  function heuristicSim(a, b) {
    if (siteOf(a.url) && siteOf(a.url) === siteOf(b.url)) {
      return 1;
    }
    const ca = categoryOf(a), cb = categoryOf(b);
    const jac = jaccard(tokens(a.title || ""), tokens(b.title || ""));
    if (ca && cb && ca === cb) {
      return 0.7 + 0.3 * jac;
    }
    return jac >= 0.3 ? 0.6 : jac;
  }

  // ---- public API ------------------------------------------------------------
  // Similarity in [0, 1]. With the model available this is the higher of the
  // embedding cosine and the heuristic score: embeddings add recall across
  // sites, while same-site and topic-keyword matches stay reliable on terse titles.
  async function similarity(tab, others) {
    const heur = others.map(o => heuristicSim(tab, o));
    if (await ensureEngine()) {
      try {
        const [v, ...vs] = await embed([textOf(tab), ...others.map(textOf)]);
        return vs.map((o, i) => Math.max(cosine(v, o), heur[i]));
      } catch (e) {
        console.warn("[auto-grouping] embed failed, heuristic fallback:", e);
      }
    }
    return heur;
  }

  /** Model-only cosine similarities (for diagnostics); null when the model is off. */
  async function modelSimilarity(tab, others) {
    if (!(await ensureEngine())) {
      return null;
    }
    const [v, ...vs] = await embed([textOf(tab), ...others.map(textOf)]);
    return vs.map(o => cosine(v, o));
  }

  /** Best existing group for `tab`, or null. Compares against each group's members. */
  async function bestGroup(tab, groups, allTabs, excludedGroupId, threshold) {
    let best = null;
    for (const g of groups) {
      if (g.id === excludedGroupId) {
        continue;
      }
      const members = allTabs.filter(t => t.groupId === g.id && t.id !== tab.id);
      if (!members.length) {
        continue;
      }
      const sims = await similarity(tab, members);
      // Mean of member similarity, boosted by a title match if the group is named.
      let score = sims.reduce((a, b) => a + b, 0) / sims.length;
      if (g.title) {
        const titleSim = (await similarity(tab, [{ title: g.title, url: "" }]))[0];
        score = Math.max(score, 0.5 * score + 0.5 * titleSim);
      }
      if (score >= threshold && (!best || score > best.score)) {
        best = { group: g, score };
      }
    }
    return best;
  }

  /** Loose tabs that cluster with the trigger tab (does not include the trigger). */
  async function clusterAround(tab, looseTabs, threshold) {
    if (!looseTabs.length) {
      return [];
    }
    const sims = await similarity(tab, looseTabs);
    const picked = looseTabs
      .map((t, i) => ({ t, s: sims[i] }))
      .filter(x => x.s >= threshold)
      .sort((a, b) => b.s - a.s)
      .map(x => x.t);
    // One expansion hop: tabs that clearly belong with a direct member join too,
    // so A~B and B~C form one cluster even when A~C alone is borderline.
    const have = new Set(picked.map(t => t.id));
    const rest = looseTabs.filter(t => !have.has(t.id));
    for (const member of picked.slice()) {
      if (!rest.length) {
        break;
      }
      const ms = await similarity(member, rest);
      for (let i = rest.length - 1; i >= 0; i--) {
        if (ms[i] >= threshold) {
          picked.push(rest[i]);
          have.add(rest[i].id);
          rest.splice(i, 1);
        }
      }
    }
    return picked;
  }

  /** Label + color for a set of tabs. Keyword majority first, then model, then site name. */
  async function label(tabs, existingTitles = []) {
    const taken = new Set(existingTitles.map(t => t.toLowerCase()));
    const counts = new Map();
    for (const t of tabs) {
      const c = categoryOf(t);
      if (c) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    let pick = null;
    for (const [c, n] of counts) {
      if (n * 2 >= tabs.length && (!pick || n > counts.get(pick))) {
        pick = c;
      }
    }
    if (!pick && engineReady && protoVecs) {
      try {
        const vecs = await embed(tabs.map(textOf));
        const c = centroid(vecs);
        let bestI = -1, bestS = -1;
        protoVecs.forEach((p, i) => {
          const s = cosine(c, p);
          if (s > bestS) {
            bestS = s;
            bestI = i;
          }
        });
        if (bestS >= 0.3) {
          pick = CATEGORIES[bestI];
        }
      } catch (e) {
        // fall through to site name
      }
    }
    let title, color;
    if (pick && !taken.has(pick.label.toLowerCase())) {
      title = pick.label;
      color = pick.color;
    } else {
      const sites = tabs.map(t => siteOf(t.url)).filter(Boolean);
      const site = sites.sort((a, b) => sites.filter(s => s === b).length - sites.filter(s => s === a).length)[0] || "Tabs";
      const base = site.split(".")[0];
      title = base.charAt(0).toUpperCase() + base.slice(1);
      color = COLORS[Math.abs(hash(title)) % COLORS.length];
    }
    let n = 2;
    const root = title;
    while (taken.has(title.toLowerCase())) {
      title = `${root} ${n++}`;
    }
    return { title, color };
  }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return h;
  }

  function status() {
    return { ...modelStatus, ready: engineReady };
  }

  /** Debug: pairwise similarity matrix for fake tabs [{title,url}], with the texts used. */
  async function debugSim(tabs) {
    const texts = tabs.map(textOf);
    const useModel = await ensureEngine();
    const matrix = [], model = [], heuristic = [];
    for (const t of tabs) {
      matrix.push(await similarity(t, tabs));
      heuristic.push(tabs.map(o => heuristicSim(t, o)));
      model.push(useModel ? await modelSimilarity(t, tabs) : null);
    }
    return { backend: useModel ? "model" : "heuristic", texts, matrix, model, heuristic };
  }

  return { ensureEngine, bestGroup, clusterAround, label, status, hostOf, siteOf, debugSim };
})();
