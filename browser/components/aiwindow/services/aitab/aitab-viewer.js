/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared AITab viewer runtime (all skins).
 *
 * Host alongside aitab-viewer.css and the skin HTML files, then set:
 *   browser.smartwindow.aitab.viewerURL = https://your.host/path/aitab-viewer.html
 *
 * Page config is always in location.hash (encodeURIComponent JSON).
 * Opening a skin without a hash uses the embedded default page and rewrites
 * the hash so reshape / refine_aitab can read the current tab URI.
 */

(function () {
  "use strict";

  /**
   * Shared AITab viewer runtime.
   * Page JSON lives in location.hash so refine_aitab / reshape can read it.
   * Hashless loads use the embedded default (or #page-config) and rewrite the hash.
   */
  var DEFAULT_PAGE_EMBEDDED = {
    version: "1",
    theme: "firefox",
    header: {
      type: "header",
      icon: "🏨",
      title: "Hotels in Lisbon",
      subhead: "4 options gathered from your open tabs",
    },
    blocks: [
      {
        type: "info",
        size: "square",
        icon: "💰",
        heading: "Cheapest",
        value: "$72 / night",
        accent: true,
      },
      {
        type: "info",
        size: "square",
        icon: "⭐",
        heading: "Top rated",
        value: "4.9 / 5",
      },
      {
        type: "info",
        size: "square",
        icon: "📍",
        heading: "Closest",
        value: "0.5 km",
      },
      {
        type: "info",
        size: "wide",
        icon: "🧭",
        heading: "At a glance",
        body: "All four options are within 2.2 km of the center; the two cheapest are also the closest.",
      },
      {
        type: "list",
        title: "Compare",
        itemType: "Hotel",
        layout: "table",
        fields: [
          {
            key: "name",
            label: "Name",
            type: "text",
            role: "title",
            property: "name",
          },
          {
            key: "price",
            label: "Price",
            type: "currency",
            role: "detail",
            suffix: " / night",
            property: "offers.price",
            goal: "min",
          },
          {
            key: "rating",
            label: "Rating",
            type: "rating",
            role: "detail",
            max: 5,
            property: "aggregateRating.ratingValue",
            goal: "max",
          },
          {
            key: "reviews",
            label: "Reviews",
            type: "number",
            role: "detail",
            property: "aggregateRating.reviewCount",
            goal: "max",
          },
          {
            key: "url",
            label: "Open tab",
            type: "url",
            role: "action",
            property: "url",
          },
        ],
        data: [
          {
            name: "Budget Central Hostel",
            price: 72,
            rating: 4.0,
            reviews: 520,
            url: "https://www.airbnb.com",
          },
          {
            name: "Old Town Boutique Inn",
            price: 145,
            rating: 4.4,
            reviews: 890,
            url: "https://www.expedia.com",
          },
          {
            name: "The Riverside Grand",
            price: 182,
            rating: 4.6,
            reviews: 2140,
            url: "https://www.booking.com",
          },
          {
            name: "Skyline Suites",
            price: 268,
            rating: 4.9,
            reviews: 3410,
            url: "https://www.hotels.com",
          },
        ],
      },
      {
        type: "todo",
        title: "Before you book",
        items: [
          { text: "Check the free-cancellation window", priority: "high" },
          {
            text: "Compare total price including taxes & fees",
            priority: "medium",
          },
          { text: "Confirm the neighborhood on a map", done: true },
        ],
      },
    ],
    footer: {
      type: "footer",
      text: "Next steps",
      buttons: [
        {
          text: "Book The Riverside Grand",
          href: "https://www.booking.com",
          variant: "primary",
        },
        {
          text: "Fewer options",
          href: "app://aitab/reshape?edit=Fewer%20options",
          variant: "secondary",
        },
        {
          text: "Prioritize price",
          href: "app://aitab/reshape?edit=Prioritize%20price",
          variant: "secondary",
        },
        {
          text: "More detail",
          href: "app://aitab/reshape?edit=More%20detail",
          variant: "secondary",
        },
      ],
    },
  };

  function parseHashPage() {
    var hash = (location.hash || "").replace(/^#/, "");
    if (!hash) {
      return null;
    }
    try {
      return JSON.parse(decodeURIComponent(hash));
    } catch (e) {
      try {
        return JSON.parse(hash);
      } catch (e2) {
        throw new Error("Could not parse AITab JSON from the URL hash.");
      }
    }
  }

  function loadDefaultPageSync() {
    var el = document.getElementById("page-config");
    if (el && el.textContent && el.textContent.trim()) {
      return JSON.parse(el.textContent);
    }
    return null;
  }

  function loadDefaultPage() {
    // Optional per-skin override via <script type="application/json" id="page-config">.
    try {
      var fromDom = loadDefaultPageSync();
      if (fromDom) {
        return Promise.resolve(fromDom);
      }
    } catch (e) {
      /* ignore invalid embedded script */
    }
    if (
      typeof DEFAULT_PAGE_EMBEDDED === "undefined" ||
      !DEFAULT_PAGE_EMBEDDED
    ) {
      return Promise.reject(new Error("No default page config embedded."));
    }
    // Clone so later local edits never mutate the embedded constant.
    return Promise.resolve(JSON.parse(JSON.stringify(DEFAULT_PAGE_EMBEDDED)));
  }

  /**
   * Put page JSON in the hash so reshape/refine can reference this tab.
   *
   * @param {object} page
   * @param {boolean} replace
   */
  function writePageHash(page, replace) {
    var encoded = encodeURIComponent(JSON.stringify(page));
    var next = location.pathname + location.search + "#" + encoded;
    if (replace) {
      history.replaceState(null, "", next);
    } else {
      history.pushState(null, "", next);
    }
  }

  function loadPageConfigFromHashOrThrow() {
    var page = parseHashPage();
    if (!page) {
      throw new Error("No page config in URL hash.");
    }
    return page;
  }

  var root = document.getElementById("page");
  var PAGE;
  var booting = true;

  /** Skin HTML files in this directory (same path, swap filename; keep hash). */
  var SKIN_VIEWS = [
    { file: "aitab-viewer.html", label: "Default", id: "default" },
    { file: "nova.html", label: "Nova", id: "nova" },
    { file: "mozilla.html", label: "Mozilla", id: "mozilla" },
  ];

  function currentSkinFile() {
    var parts = (location.pathname || "").split("/");
    var name = parts[parts.length - 1] || "";
    return name || "aitab-viewer.html";
  }

  /**
   * Same directory + query + hash, different skin file.
   *
   * @param {string} file
   * @returns {string}
   */
  function skinHref(file) {
    var dir = location.pathname.replace(/[^/]*$/, "");
    return dir + file + (location.search || "") + (location.hash || "");
  }

  /**
   * Fixed header (skin switcher) + fixed footer (Made with Smart Window).
   * Injected once so every skin HTML gets the same chrome.
   */
  function installAppChrome() {
    if (document.querySelector(".aitab-viewbar")) {
      refreshSkinLinks();
      return;
    }

    document.body.classList.add("has-aitab-chrome");

    var bar = document.createElement("header");
    bar.className = "aitab-viewbar";
    bar.setAttribute("role", "banner");

    var brand = document.createElement("div");
    brand.className = "aitab-viewbar-brand";
    brand.textContent = "AITab";
    bar.appendChild(brand);

    var nav = document.createElement("nav");
    nav.className = "aitab-viewbar-nav";
    nav.setAttribute("aria-label", "Viewer skin");
    SKIN_VIEWS.forEach(function (view) {
      var a = document.createElement("a");
      a.className = "aitab-viewbar-link";
      a.dataset.skinFile = view.file;
      a.dataset.skinId = view.id;
      a.textContent = view.label;
      a.href = skinHref(view.file);
      nav.appendChild(a);
    });
    bar.appendChild(nav);

    var foot = document.createElement("footer");
    foot.className = "aitab-brand-footer";
    foot.setAttribute("role", "contentinfo");
    var mark = document.createElement("span");
    mark.className = "aitab-brand-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "✦";
    var label = document.createElement("span");
    label.className = "aitab-brand-label";
    label.textContent = "Made with Smart Window";
    foot.appendChild(mark);
    foot.appendChild(label);

    document.body.insertBefore(bar, document.body.firstChild);
    document.body.appendChild(foot);
    refreshSkinLinks();
  }

  /** Keep skin links on the current hash/query after persist/hashchange. */
  function refreshSkinLinks() {
    var current = currentSkinFile();
    document.querySelectorAll(".aitab-viewbar-link").forEach(function (a) {
      var file = a.dataset.skinFile;
      if (!file) {
        return;
      }
      a.href = skinHref(file);
      var active = file === current;
      a.classList.toggle("is-active", active);
      if (active) {
        a.setAttribute("aria-current", "page");
      } else {
        a.removeAttribute("aria-current");
      }
    });
  }

  /**
   * Apply document chrome that depends on PAGE (title, theme).
   * Called on first load and after hashchange (reshape reload).
   */
  function applyPageChrome() {
    if (PAGE.header && PAGE.header.title) {
      document.title = PAGE.header.title;
    } else {
      document.title = "AITab";
    }
    var rootEl = document.documentElement;
    // Skins (data-skin) supply their own tokens in inline CSS. Only set
    // data-theme for the default skin so shared [data-theme] palettes apply.
    if (!rootEl.hasAttribute("data-skin")) {
      rootEl.setAttribute("data-theme", PAGE.theme || "firefox");
    }
    // data-mode is used by skins for dark overrides with higher specificity
    // than shared [data-theme][data-mode="dark"] rules.
    rootEl.setAttribute(
      "data-mode",
      window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
    );
  }

  function showFatal(err) {
    if (!root) {
      return;
    }
    // Trusted static chrome + escaped error text only (no untrusted markup).
    // eslint-disable-next-line no-unsanitized/property
    root.innerHTML =
      '<p style="padding:2rem;font:message-box;color:#5b5b66">' +
      String((err && err.message) || err) +
      "</p>";
  }

  function setPage(page) {
    PAGE = page;
    applyPageChrome();
  }

  /* ---- shared helpers ---------------------------------------------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function byRole(schema, role) {
    return schema.fields.filter(function (f) {
      return (f.role || "detail") === role;
    });
  }
  function firstByRole(schema, role) {
    return byRole(schema, role)[0] || null;
  }
  function has(row, f) {
    if (!f) {
      return false;
    }
    var v = row[f.key];
    if (v === undefined || v === null || v === "") {
      return false;
    }
    if (Array.isArray(v) && !v.length) {
      return false;
    }
    return true;
  }
  function formatValue(field, value) {
    var pre = field.prefix || "",
      suf = field.suffix || "";
    switch (field.type) {
      case "currency":
        return (
          pre +
          Number(value).toLocaleString(undefined, {
            style: "currency",
            currency: field.currency || "USD",
            maximumFractionDigits: 0,
          }) +
          suf
        );
      case "number":
        return pre + Number(value).toLocaleString() + suf;
      case "date":
        var d = new Date(value);
        return isNaN(d)
          ? esc(value)
          : d.toLocaleDateString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
      case "boolean":
        return value
          ? '<span class="bool yes">✓ Yes</span>'
          : '<span class="bool no">✕ No</span>';
      case "rating":
        var max = field.max || 5,
          full = Math.round(Number(value)),
          s = "";
        for (var i = 0; i < max; i++) {
          s += i < full ? "★" : "☆";
        }
        return (
          '<span class="stars">' +
          s +
          '<span class="num">' +
          esc(value) +
          "/" +
          max +
          "</span></span>"
        );
      case "tags":
        return (
          '<span class="chips">' +
          (value || [])
            .map(function (t) {
              return '<span class="chip">' + esc(t) + "</span>";
            })
            .join("") +
          "</span>"
        );
      default:
        return pre + esc(value) + suf;
    }
  }
  function thumb(schema, row) {
    var f = firstByRole(schema, "image");
    return has(row, f)
      ? '<img class="thumb" loading="lazy" alt="" src="' +
          esc(row[f.key]) +
          '" onerror="this.style.visibility=\'hidden\'" />'
      : "";
  }
  function badge(schema, row) {
    var f = firstByRole(schema, "badge");
    return has(row, f)
      ? '<span class="badge">' + esc(row[f.key]) + "</span>"
      : "";
  }
  function action(schema, row) {
    var f = firstByRole(schema, "action");
    return has(row, f)
      ? '<a class="btn secondary" target="_blank" rel="noopener" href="' +
          esc(row[f.key]) +
          '">' +
          esc(f.label || "Open") +
          " ↗</a>"
      : "";
  }

  /* ---- list superpowers: aggregates, best-value, JSON-LD ----------------- */
  var NUMERIC = { number: 1, currency: 1, rating: 1 };
  var currentBest = null;
  function bestClass(row) {
    return row === currentBest ? " is-best" : "";
  }
  function ribbon(row) {
    return row === currentBest
      ? '<span class="ribbon">★ Best value</span>'
      : "";
  }
  function formatNum(field, value) {
    var n = Number(value);
    if (field.type === "currency") {
      return n.toLocaleString(undefined, {
        style: "currency",
        currency: field.currency || "USD",
        maximumFractionDigits: 0,
      });
    }
    if (field.type === "rating") {
      return n.toFixed(1);
    }
    var r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    return r.toLocaleString() + (field.suffix || "");
  }
  function aggregate(field, rows) {
    var vals = [];
    rows.forEach(function (r) {
      var v = Number(r[field.key]);
      if (!isNaN(v)) {
        vals.push(v);
      }
    });
    if (!vals.length) {
      return null;
    }
    var sum = vals.reduce(function (a, b) {
      return a + b;
    }, 0);
    return {
      min: Math.min.apply(null, vals),
      max: Math.max.apply(null, vals),
      avg: sum / vals.length,
    };
  }
  function computeBest(schema, rows) {
    var usable = schema.fields
      .filter(function (f) {
        return f.goal && NUMERIC[f.type];
      })
      .map(function (f) {
        var a = aggregate(f, rows);
        return a && a.max !== a.min ? { f, a } : null;
      })
      .filter(Boolean);
    if (usable.length < 2 || rows.length < 2) {
      return null;
    }
    var best = null,
      top = -1;
    rows.forEach(function (row) {
      var s = 0,
        n = 0;
      usable.forEach(function (u) {
        var v = Number(row[u.f.key]);
        if (isNaN(v)) {
          return;
        }
        var norm = (v - u.a.min) / (u.a.max - u.a.min);
        if (u.f.goal === "min") {
          norm = 1 - norm;
        }
        s += norm;
        n++;
      });
      if (n) {
        var sc = s / n;
        if (sc > top) {
          top = sc;
          best = row;
        }
      }
    });
    return best;
  }
  function summaryHtml(schema, rows) {
    var numFields = schema.fields.filter(function (f) {
      return NUMERIC[f.type];
    });
    if (!numFields.length || !rows.length) {
      return "";
    }
    var nameF = firstByRole(schema, "title") || schema.fields[0];
    var tiles =
      '<div class="stat"><div class="s-val">' +
      rows.length +
      '</div><div class="s-lab">' +
      (rows.length === 1 ? "option" : "options") +
      "</div></div>";
    numFields.forEach(function (f) {
      var a = aggregate(f, rows);
      if (!a) {
        return;
      }
      tiles +=
        '<div class="stat"><div class="s-val">' +
        formatNum(f, a.avg) +
        '</div><div class="s-lab">avg ' +
        esc(f.label) +
        '</div><div class="s-sub">' +
        formatNum(f, a.min) +
        " – " +
        formatNum(f, a.max) +
        "</div></div>";
    });
    var chips = "";
    if (currentBest) {
      chips +=
        '<div class="callout best"><span class="c-kick">★ Best value</span><span class="c-name">' +
        esc(currentBest[nameF.key]) +
        "</span></div>";
    }
    schema.fields
      .filter(function (f) {
        return f.goal && NUMERIC[f.type];
      })
      .forEach(function (f) {
        var winner = null,
          wv = null;
        rows.forEach(function (r) {
          var v = Number(r[f.key]);
          if (isNaN(v)) {
            return;
          }
          if (wv === null || (f.goal === "min" ? v < wv : v > wv)) {
            wv = v;
            winner = r;
          }
        });
        if (!winner) {
          return;
        }
        chips +=
          '<div class="callout"><span class="c-kick">' +
          esc((f.goal === "min" ? "Lowest " : "Highest ") + f.label) +
          '</span><span class="c-name">' +
          esc(winner[nameF.key]) +
          '</span><span class="c-val">' +
          formatValue(f, winner[f.key]) +
          "</span></div>";
      });
    return (
      '<div class="stats">' +
      tiles +
      "</div>" +
      (chips ? '<div class="callouts">' + chips + "</div>" : "")
    );
  }
  var CONTAINER_TYPES = {
    offers: "Offer",
    aggregateRating: "AggregateRating",
    address: "PostalAddress",
    geo: "GeoCoordinates",
  };
  function setPath(o, p, val) {
    var ps = p.split("."),
      c = o;
    for (var i = 0; i < ps.length - 1; i++) {
      var k = ps[i];
      if (!c[k]) {
        c[k] = {};
        if (CONTAINER_TYPES[k]) {
          c[k]["@type"] = CONTAINER_TYPES[k];
        }
      }
      c = c[k];
    }
    c[ps[ps.length - 1]] = val;
  }
  function buildJsonLd(block) {
    var mapped = block.fields.filter(function (f) {
      return f.property;
    });
    return {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: block.title || "",
      numberOfItems: block.data.length,
      itemListElement: block.data.map(function (row, i) {
        var item = { "@type": block.itemType || "Thing" };
        mapped.forEach(function (f) {
          var v = row[f.key];
          if (v === undefined || v === null || v === "") {
            return;
          }
          var val = NUMERIC[f.type] ? Number(v) : v;
          setPath(item, f.property, val);
          if (f.type === "currency" && /\.price$/.test(f.property)) {
            setPath(
              item,
              f.property.replace(/price$/, "priceCurrency"),
              f.currency || "USD"
            );
          }
        });
        return { "@type": "ListItem", position: i + 1, item };
      }),
    };
  }
  function emitJsonLd() {
    var old = document.querySelectorAll("script.aitab-ld");
    for (var i = 0; i < old.length; i++) {
      // Prefer Element.remove() over parentNode.removeChild (eslint
      // mozilla/avoid-removeChild).
      old[i].remove();
    }
    (PAGE.blocks || [])
      .filter(function (b) {
        return b.type === "list" && b.itemType;
      })
      .forEach(function (b) {
        var s = document.createElement("script");
        s.type = "application/ld+json";
        s.className = "aitab-ld";
        s.textContent = JSON.stringify(buildJsonLd(b), null, 2);
        document.head.appendChild(s);
      });
  }

  /* ---- list layout sub-registry ------------------------------------------ */

  /* ---- modify helpers (hover add/remove → reshape) -------------------- */
  function itemLabelFor(block) {
    if (block && block.itemType) {
      return String(block.itemType)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
    }
    if (block && block.type === "todo") {
      return "task";
    }
    if (block && block.type === "info") {
      return "stat";
    }
    return "item";
  }
  function removeBtn() {
    return (
      '<button type="button" class="mod-remove" data-mod-action="remove" title="Remove">' +
      "Remove</button>"
    );
  }
  function addBar(label) {
    return (
      '<button type="button" class="mod-add-bar" data-mod-action="add">' +
      '<span class="plus" aria-hidden="true">+</span>' +
      "<span>Add " +
      esc(label) +
      "</span></button>"
    );
  }
  function wrapModScope(inner, blockIndex, label, extraAttrs) {
    return (
      '<div class="mod-scope" data-mod-scope data-mod-block="' +
      blockIndex +
      '" data-mod-label="' +
      esc(label) +
      '"' +
      (extraAttrs || "") +
      ">" +
      inner +
      addBar(label) +
      "</div>"
    );
  }
  function rowAttrs(i) {
    return ' data-mod-row data-mod-index="' + i + '"';
  }
  function rowTitle(schema, row, index) {
    var titleF = firstByRole(schema, "title");
    if (titleF && row && row[titleF.key] != null && row[titleF.key] !== "") {
      return String(row[titleF.key]);
    }
    if (row && row.text) {
      return String(row.text);
    }
    return itemLabelFor(schema) + " " + (index + 1);
  }

  var LAYOUTS = {
    cards(schema, rows) {
      var titleF = firstByRole(schema, "title"),
        subF = firstByRole(schema, "subtitle"),
        details = byRole(schema, "detail");
      return rows
        .map(function (row, i) {
          var img = thumb(schema, row),
            a = action(schema, row);
          var h =
            '<div class="card' +
            (img ? "" : " no-image") +
            bestClass(row) +
            '"' +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(rowTitle(schema, row, i)) +
            '">' +
            img +
            '<div class="body">';
          h += '<div class="titlerow">';
          if (titleF) {
            h += '<h2 class="title">' + esc(row[titleF.key]) + "</h2>";
          }
          h += badge(schema, row) + ribbon(row) + "</div>";
          if (has(row, subF)) {
            h += '<p class="subtitle">' + esc(row[subF.key]) + "</p>";
          }
          if (details.length) {
            h += '<div class="details">';
            details.forEach(function (f) {
              if (!has(row, f)) {
                return;
              }
              var full = f.type === "tags" || f.type === "long" ? " full" : "";
              h +=
                '<div class="detail' +
                full +
                '"><div class="k">' +
                esc(f.label) +
                '</div><div class="v">' +
                formatValue(f, row[f.key]) +
                "</div></div>";
            });
            h += "</div>";
          }
          h += "</div>";
          if (a) {
            h += '<div class="action">' + a + "</div>";
          }
          return h + removeBtn() + "</div>";
        })
        .join("");
    },
    compact(schema, rows) {
      var titleF = firstByRole(schema, "title"),
        subF = firstByRole(schema, "subtitle");
      var details = byRole(schema, "detail").filter(function (f) {
        return f.type !== "long";
      });
      return rows
        .map(function (row, i) {
          var img = thumb(schema, row),
            a = action(schema, row);
          var h =
            '<div class="row' +
            bestClass(row) +
            '"' +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(rowTitle(schema, row, i)) +
            '">' +
            img +
            '<div class="row-main">';
          if (titleF) {
            h += '<div class="title">' + esc(row[titleF.key]) + "</div>";
          }
          h += has(row, subF)
            ? '<div class="subtitle">' + esc(row[subF.key]) + "</div>"
            : "";
          h += "</div>" + badge(schema, row) + ribbon(row);
          h += '<div class="row-meta">';
          details.forEach(function (f) {
            if (has(row, f)) {
              h +=
                '<span class="m"><em>' +
                esc(f.label) +
                "</em>" +
                formatValue(f, row[f.key]) +
                "</span>";
            }
          });
          h += "</div>";
          if (a) {
            h += '<div class="action">' + a + "</div>";
          }
          return h + removeBtn() + "</div>";
        })
        .join("");
    },
    grid(schema, rows) {
      var titleF = firstByRole(schema, "title"),
        subF = firstByRole(schema, "subtitle"),
        details = byRole(schema, "detail");
      return rows
        .map(function (row, i) {
          var h =
            '<div class="tile' +
            bestClass(row) +
            '"' +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(rowTitle(schema, row, i)) +
            '">' +
            thumb(schema, row) +
            '<div class="tile-body">';
          h += '<div class="titlerow">';
          if (titleF) {
            h += '<span class="title">' + esc(row[titleF.key]) + "</span>";
          }
          h += badge(schema, row) + ribbon(row) + "</div>";
          if (has(row, subF)) {
            h += '<div class="subtitle">' + esc(row[subF.key]) + "</div>";
          }
          if (details.length) {
            h += '<div class="details">';
            details.forEach(function (f) {
              if (!has(row, f)) {
                return;
              }
              var full = f.type === "tags" || f.type === "long" ? " full" : "";
              h +=
                '<div class="detail' +
                full +
                '"><span class="k">' +
                esc(f.label) +
                '</span><span class="v">' +
                formatValue(f, row[f.key]) +
                "</span></div>";
            });
            h += "</div>";
          }
          var a = action(schema, row);
          if (a) {
            h += '<div class="action">' + a + "</div>";
          }
          return h + removeBtn() + "</div></div>";
        })
        .join("");
    },
    table(schema, rows) {
      var titleF = firstByRole(schema, "title"),
        imageF = firstByRole(schema, "image"),
        badgeF = firstByRole(schema, "badge"),
        actionF = firstByRole(schema, "action");
      var cols = byRole(schema, "detail");
      var head =
        "<tr><th>" + esc(titleF ? titleF.label || "Name" : "Name") + "</th>";
      if (badgeF) {
        head += "<th>" + esc(badgeF.label || "Status") + "</th>";
      }
      cols.forEach(function (f) {
        head += "<th>" + esc(f.label) + "</th>";
      });
      if (actionF) {
        head += "<th></th>";
      }
      head += "<th></th></tr>";
      var body = rows
        .map(function (row, i) {
          var img =
            imageF && has(row, imageF)
              ? '<img class="thumb" loading="lazy" alt="" src="' +
                esc(row[imageF.key]) +
                '" onerror="this.style.display=\'none\'" />'
              : "";
          var cls = bestClass(row).trim();
          var r =
            "<tr" +
            (cls ? ' class="' + cls + '"' : "") +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(rowTitle(schema, row, i)) +
            '">';
          r +=
            '<td><div class="cell-title">' +
            img +
            "<span>" +
            esc(titleF ? row[titleF.key] : "") +
            "</span>" +
            ribbon(row) +
            "</div></td>";
          if (badgeF) {
            r += "<td>" + badge(schema, row) + "</td>";
          }
          cols.forEach(function (f) {
            r +=
              "<td>" +
              (has(row, f) ? formatValue(f, row[f.key]) : "—") +
              "</td>";
          });
          if (actionF) {
            r += "<td>" + action(schema, row) + "</td>";
          }
          r += '<td class="mod-cell">' + removeBtn() + "</td></tr>";
          return r;
        })
        .join("");
      return (
        '<table class="tbl"><thead>' +
        head +
        "</thead><tbody>" +
        body +
        "</tbody></table>"
      );
    },
  };

  /* ==========================================================================
     BLOCK RENDERER REGISTRY — one entry per component `type`.
     Each returns an HTML string. This mirrors schemas/ 1:1.
     ========================================================================== */
  function sourceChipsHtml(sources) {
    if (!Array.isArray(sources) || !sources.length) {
      return "";
    }
    var chips = sources
      .map(function (s) {
        if (!s || !s.label) {
          return "";
        }
        var label = esc(s.label);
        if (s.url) {
          return (
            '<a class="src-chip" href="' +
            esc(s.url) +
            '" target="_blank" rel="noopener">' +
            label +
            "</a>"
          );
        }
        return '<span class="src-chip">' + label + "</span>";
      })
      .filter(Boolean)
      .join("");
    return chips ? '<div class="src-chips">' + chips + "</div>" : "";
  }

  function contrastSideHtml(side) {
    if (!side) {
      return "";
    }
    var variant = side.variant === "accent" ? "accent" : "soft";
    var body = "";
    if (Array.isArray(side.sections) && side.sections.length) {
      body = side.sections
        .map(function (sec) {
          return (
            '<div class="contrast-section">' +
            (sec.heading
              ? '<h4 class="contrast-sec-head">' + esc(sec.heading) + "</h4>"
              : "") +
            (sec.body
              ? '<p class="contrast-sec-body">' + esc(sec.body) + "</p>"
              : "") +
            "</div>"
          );
        })
        .join("");
    } else if (Array.isArray(side.items) && side.items.length) {
      body =
        '<ul class="contrast-bullets">' +
        side.items
          .map(function (item) {
            return "<li>" + esc(item) + "</li>";
          })
          .join("") +
        "</ul>";
    }
    return (
      '<div class="contrast-card contrast-' +
      variant +
      '">' +
      '<h3 class="contrast-card-title">' +
      esc(side.title || "") +
      "</h3>" +
      body +
      "</div>"
    );
  }

  var RENDERERS = {
    header(b) {
      return (
        '<header class="page-header">' +
        (b.icon ? '<div class="ph-icon">' + esc(b.icon) + "</div>" : "") +
        "<div><h1>" +
        esc(b.title) +
        "</h1>" +
        (b.subhead ? '<p class="ph-sub">' + esc(b.subhead) + "</p>" : "") +
        "</div></header>"
      );
    },
    info(b) {
      var inner = "";
      if (b.icon) {
        inner += '<div class="pi-icon">' + esc(b.icon) + "</div>";
      }
      if (b.heading) {
        inner += '<div class="pi-head">' + esc(b.heading) + "</div>";
      }
      if (b.value) {
        inner += '<div class="pi-val">' + esc(b.value) + "</div>";
      }
      if (b.body) {
        inner += '<div class="pi-body">' + esc(b.body) + "</div>";
      }
      var cls =
        "panel panel-" +
        (b.size === "wide" ? "wide" : "square") +
        (b.accent ? " accent" : "");
      return b.href
        ? '<a class="' + cls + '" href="' + esc(b.href) + '">' + inner + "</a>"
        : '<div class="' + cls + '">' + inner + "</div>";
    },
    takeaways(b) {
      var items = b.items || [];
      var rows = items
        .map(function (item, i) {
          var num = String(i + 1).padStart(2, "0");
          return (
            '<article class="takeaway-item">' +
            '<div class="takeaway-index">' +
            esc(num) +
            "</div>" +
            '<div class="takeaway-main">' +
            '<h3 class="takeaway-heading">' +
            esc(item.heading || "") +
            "</h3>" +
            "</div>" +
            '<div class="takeaway-detail">' +
            (item.body
              ? '<p class="takeaway-body">' + esc(item.body) + "</p>"
              : "") +
            sourceChipsHtml(item.sources) +
            "</div>" +
            "</article>"
          );
        })
        .join("");
      return (
        '<section class="block takeaways">' +
        (b.title
          ? '<h2 class="block-title takeaways-title">' + esc(b.title) + "</h2>"
          : '<h2 class="block-title takeaways-title">Key Takeaways</h2>') +
        '<div class="takeaway-list">' +
        rows +
        "</div></section>"
      );
    },
    contrast(b) {
      return (
        '<section class="block contrast">' +
        (b.title ? '<h2 class="block-title">' + esc(b.title) + "</h2>" : "") +
        '<div class="contrast-pair">' +
        contrastSideHtml(b.left) +
        contrastSideHtml(b.right) +
        "</div></section>"
      );
    },
    list(b, index) {
      var layout = LAYOUTS[b.layout] ? b.layout : "cards";
      var rows = b.data || [];
      currentBest = computeBest(b, rows);
      var summary = summaryHtml(b, rows);
      var listHtml = rows.length
        ? LAYOUTS[layout](b, rows)
        : '<div class="empty">No items.</div>';
      currentBest = null;
      var label = itemLabelFor(b);
      var blockIndex = typeof index === "number" ? index : 0;
      var inner =
        (b.title ? '<h2 class="block-title">' + esc(b.title) + "</h2>" : "") +
        (b.description
          ? '<p class="block-desc">' + esc(b.description) + "</p>"
          : "") +
        (summary ? '<div class="summary">' + summary + "</div>" : "") +
        '<div class="list layout-' +
        layout +
        '">' +
        listHtml +
        "</div>";
      return (
        '<section class="block list-block">' +
        wrapModScope(inner, blockIndex, label, ' data-mod-kind="list"') +
        "</section>"
      );
    },
    todo(b, index) {
      var items = b.items || [];
      var done = items.filter(function (t) {
        return t.done;
      }).length;
      var prog =
        b.showProgress !== false
          ? '<p class="todo-prog">' + done + " of " + items.length + " done</p>"
          : "";
      var label = itemLabelFor(b);
      var lis = items
        .map(function (t, i) {
          var meta = "";
          if (t.priority) {
            meta +=
              '<span class="pri ' +
              esc(t.priority) +
              '">' +
              esc(t.priority) +
              "</span>";
          }
          if (t.due) {
            meta += "<span>Due " + esc(t.due) + "</span>";
          }
          if (t.note) {
            meta += "<span>" + esc(t.note) + "</span>";
          }
          if (t.href) {
            meta +=
              '<a href="' +
              esc(t.href) +
              '" target="_blank" rel="noopener">Open ↗</a>';
          }
          return (
            '<li class="todo-item' +
            (t.done ? " done" : "") +
            '" data-idx="' +
            i +
            '"' +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(t.text || "task " + (i + 1)) +
            '">' +
            '<label><input type="checkbox" class="todo-cb"' +
            (t.done ? " checked" : "") +
            "/>" +
            '<span class="tx">' +
            esc(t.text) +
            "</span></label>" +
            (meta ? '<div class="todo-meta">' + meta + "</div>" : "") +
            removeBtn() +
            "</li>"
          );
        })
        .join("");
      var blockIndex = typeof index === "number" ? index : 0;
      var inner =
        (b.title ? '<h2 class="block-title">' + esc(b.title) + "</h2>" : "") +
        prog +
        '<ul class="todo-list">' +
        lis +
        "</ul>";
      return (
        '<section class="block todo" data-block="' +
        blockIndex +
        '">' +
        wrapModScope(inner, blockIndex, label, ' data-mod-kind="todo"') +
        "</section>"
      );
    },
    footer(b) {
      var list = footerButtonsWithReshapeFallback(b.buttons || []);
      var label = "action";
      var btns = list
        .map(function (btn, i) {
          var edit = parseReshapeHref(btn.href);
          var variant = btn.variant === "primary" ? "primary" : "secondary";
          var control;
          if (edit) {
            control =
              '<button type="button" class="btn ' +
              variant +
              ' reshape" data-aitab-reshape data-edit="' +
              esc(edit) +
              '" data-label="' +
              esc(btn.text) +
              '">' +
              esc(btn.text) +
              "</button>";
          } else {
            control =
              '<a class="btn ' +
              variant +
              '" href="' +
              esc(btn.href) +
              '">' +
              esc(btn.text) +
              "</a>";
          }
          return (
            '<span class="pf-btn-wrap"' +
            rowAttrs(i) +
            ' data-mod-title="' +
            esc(btn.text || "action") +
            '">' +
            control +
            removeBtn() +
            "</span>"
          );
        })
        .join("");
      return (
        '<footer class="page-footer">' +
        (b.text ? '<div class="pf-text">' + esc(b.text) + "</div>" : "") +
        '<div class="mod-scope" data-mod-scope data-mod-kind="footer" data-mod-label="' +
        esc(label) +
        '">' +
        '<div class="pf-buttons">' +
        btns +
        "</div>" +
        addBar(label) +
        "</div></footer>"
      );
    },
  };

  /* ---- compose ----------------------------------------------------------- */
  function renderBody(blocks) {
    var out = "",
      i = 0;
    while (i < blocks.length) {
      var b = blocks[i];
      if (b.type === "info") {
        var start = i;
        var groupHtml = "";
        var g = 0;
        while (i < blocks.length && blocks[i].type === "info") {
          var panel = blocks[i];
          var inner = "";
          if (panel.icon) {
            inner += '<div class="pi-icon">' + esc(panel.icon) + "</div>";
          }
          if (panel.heading) {
            inner += '<div class="pi-head">' + esc(panel.heading) + "</div>";
          }
          if (panel.value) {
            inner += '<div class="pi-val">' + esc(panel.value) + "</div>";
          }
          if (panel.body) {
            inner += '<div class="pi-body">' + esc(panel.body) + "</div>";
          }
          var cls =
            "panel panel-" +
            (panel.size === "wide" ? "wide" : "square") +
            (panel.accent ? " accent" : "");
          var title = panel.heading || panel.value || "stat " + (g + 1);
          groupHtml +=
            '<div class="' +
            cls +
            '"' +
            rowAttrs(g) +
            ' data-mod-info-block="' +
            i +
            '" data-mod-title="' +
            esc(String(title)) +
            '">' +
            inner +
            removeBtn() +
            "</div>";
          g++;
          i++;
        }
        out += wrapModScope(
          '<div class="panels">' + groupHtml + "</div>",
          start,
          "stat",
          ' data-mod-kind="info-group" data-mod-end="' + (i - 1) + '"'
        );
      } else {
        out += RENDERERS[b.type] ? RENDERERS[b.type](b, i) : "";
        i++;
      }
    }
    return out;
  }

  /**
   * Parse app://aitab/reshape?edit=… (or app://reshape?edit=…).
   *
   * @param {string} href
   * @returns {string|null} decoded edit instruction
   */
  function parseReshapeHref(href) {
    if (!href || typeof href !== "string") {
      return null;
    }
    var h = href.trim();
    var prefix = "app://aitab/reshape";
    var alt = "app://reshape";
    if (h.indexOf(prefix) !== 0 && h.indexOf(alt) !== 0) {
      return null;
    }
    var q = h.indexOf("?");
    if (q < 0) {
      return null;
    }
    var query = h.slice(q + 1);
    var parts = query.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (decodeURIComponent(kv[0] || "") === "edit") {
        try {
          return decodeURIComponent(
            (kv.slice(1).join("=") || "").replace(/\+/g, " ")
          ).trim();
        } catch (e) {
          return (kv.slice(1).join("=") || "").trim();
        }
      }
    }
    return null;
  }

  function defaultReshapeFooterButtons() {
    return [
      {
        text: "Fewer options",
        href: "app://aitab/reshape?edit=" + encodeURIComponent("Fewer options"),
        variant: "secondary",
      },
      {
        text: "Prioritize price",
        href:
          "app://aitab/reshape?edit=" + encodeURIComponent("Prioritize price"),
        variant: "secondary",
      },
      {
        text: "More detail",
        href: "app://aitab/reshape?edit=" + encodeURIComponent("More detail"),
        variant: "secondary",
      },
    ];
  }

  /**
   * If the model omitted reshape chips, append defaults (render only).
   *
   * @param {Array<{text?: string, href?: string, variant?: string}>} buttons
   * @returns {Array<{text?: string, href?: string, variant?: string}>}
   */
  function footerButtonsWithReshapeFallback(buttons) {
    var list = Array.isArray(buttons) ? buttons.slice() : [];
    var hasReshape = list.some(function (b) {
      return !!parseReshapeHref(b && b.href);
    });
    if (!hasReshape) {
      list = list.concat(defaultReshapeFooterButtons());
    }
    return list;
  }

  /**
   * Ask Firefox to open the sidebar with a reshape prompt.
   *
   * @param {string} edit
   * @param {string} [label]
   * @param {{ autoSubmit?: boolean, source?: string }} [opts]
   */
  function requestReshape(edit, label, opts) {
    opts = opts || {};
    var text = edit || label || "";
    // Keep trailing spaces for incomplete "Add …: " prompts.
    if (!String(text).trim()) {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("AITab:Reshape", {
        bubbles: true,
        composed: true,
        detail: {
          edit: text,
          label: String(label || text).trim(),
          source: opts.source || "page",
          autoSubmit: opts.autoSubmit !== false,
        },
      })
    );
  }

  /**
   * Write PAGE into the URL hash (source of truth for refine_aitab) and
   * re-render. Uses replaceState so we don't spam history or rely on AI.
   */
  function persistPageAndRender() {
    try {
      writePageHash(PAGE, true);
    } catch (err) {
      console.warn("AITab: could not persist page to hash", err);
    }
    applyPageChrome();
    build();
    refreshSkinLinks();
  }

  /**
   * Deterministic remove — mutates PAGE JSON in place. No AI.
   *
   * @param {Element} scope
   * @param {Element} row
   * @returns {boolean} whether anything was removed
   */
  function removeFromPage(scope, row) {
    if (!scope || !row) {
      return false;
    }
    var kind = scope.getAttribute("data-mod-kind") || "";
    var idx = +row.getAttribute("data-mod-index");

    if (kind === "info-group") {
      var infoIdx = +row.getAttribute("data-mod-info-block");
      if (isNaN(infoIdx) || !PAGE.blocks) {
        return false;
      }
      if (infoIdx < 0 || infoIdx >= PAGE.blocks.length) {
        return false;
      }
      if (PAGE.blocks[infoIdx].type !== "info") {
        return false;
      }
      PAGE.blocks.splice(infoIdx, 1);
      return true;
    }

    if (kind === "footer") {
      if (!PAGE.footer) {
        PAGE.footer = { type: "footer", text: "Next steps", buttons: [] };
      }
      // Materialize render-time reshape fallbacks so remove edits the
      // real config (and subsequent reloads stay consistent).
      PAGE.footer.buttons = footerButtonsWithReshapeFallback(
        PAGE.footer.buttons || []
      );
      if (isNaN(idx) || idx < 0 || idx >= PAGE.footer.buttons.length) {
        return false;
      }
      PAGE.footer.buttons.splice(idx, 1);
      if (!PAGE.footer.buttons.length) {
        // Keep a valid footer object; viewer will re-add defaults if needed.
        PAGE.footer.buttons = [];
      }
      return true;
    }

    var blockIndex = +scope.getAttribute("data-mod-block");
    if (isNaN(blockIndex) || !PAGE.blocks) {
      return false;
    }
    var block = PAGE.blocks[blockIndex];
    if (!block) {
      return false;
    }

    if (kind === "list" || block.type === "list") {
      if (!Array.isArray(block.data) || isNaN(idx)) {
        return false;
      }
      if (idx < 0 || idx >= block.data.length) {
        return false;
      }
      block.data.splice(idx, 1);
      return true;
    }

    if (kind === "todo" || block.type === "todo") {
      if (!Array.isArray(block.items) || isNaN(idx)) {
        return false;
      }
      if (idx < 0 || idx >= block.items.length) {
        return false;
      }
      block.items.splice(idx, 1);
      return true;
    }

    return false;
  }

  function build() {
    var html = "";
    if (PAGE.header) {
      html += RENDERERS.header(PAGE.header);
    }
    html += renderBody(PAGE.blocks || []);
    // Always show a footer so reshape buttons have a home.
    var footer = PAGE.footer || {
      type: "footer",
      text: "Next steps",
      buttons: [],
    };
    html += RENDERERS.footer(footer);
    // Built from escaped/trusted page config fields only (esc() on text).
    // eslint-disable-next-line no-unsanitized/property
    root.innerHTML = html;
    emitJsonLd();
  }

  // interactive: toggling a todo checkbox updates state, hash, rebuilds
  root.addEventListener("change", function (e) {
    if (!e.target.classList || !e.target.classList.contains("todo-cb")) {
      return;
    }
    var li = e.target.closest("[data-idx]"),
      sec = e.target.closest("[data-block]");
    if (!li || !sec) {
      return;
    }
    var block = PAGE.blocks[+sec.getAttribute("data-block")];
    if (block && block.items) {
      block.items[+li.getAttribute("data-idx")].done = e.target.checked;
      persistPageAndRender();
    }
  });

  root.addEventListener("click", function (e) {
    var reshapeChip = e.target.closest
      ? e.target.closest("[data-aitab-reshape]")
      : null;
    if (reshapeChip) {
      e.preventDefault();
      requestReshape(
        reshapeChip.getAttribute("data-edit"),
        reshapeChip.getAttribute("data-label"),
        { autoSubmit: true, source: "footer" }
      );
      return;
    }

    var btn = e.target.closest ? e.target.closest("[data-mod-action]") : null;
    if (!btn) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    var scope = btn.closest("[data-mod-scope]");
    if (!scope) {
      return;
    }
    var modAction = btn.getAttribute("data-mod-action");
    var label = scope.getAttribute("data-mod-label") || "item";

    if (modAction === "add") {
      // Prefill only — user types the concrete name (ingredient, hotel…).
      requestReshape("Add a new " + label + ": ", "Add " + label, {
        autoSubmit: false,
        source: "add",
      });
      return;
    }

    if (modAction === "remove") {
      var row = btn.closest("[data-mod-row]");
      if (removeFromPage(scope, row)) {
        persistPageAndRender();
      }
    }
  });

  /**
   * refine_aitab navigates the same tab to a new viewer URL whose only
   * change is often the hash. That is a same-document navigation, so
   * scripts do not re-run — listen for hashchange and re-render.
   */
  function reloadFromLocation() {
    if (booting) {
      return;
    }
    try {
      setPage(loadPageConfigFromHashOrThrow());
      build();
      refreshSkinLinks();
    } catch (err) {
      showFatal(err);
    }
  }

  window.addEventListener("hashchange", reloadFromLocation);
  window.addEventListener("popstate", reloadFromLocation);

  /**
   * Boot: prefer hash; if missing, load default JSON and rewrite the hash
   * so this tab is a valid reshape/refine_aitab target.
   */
  function boot() {
    installAppChrome();
    booting = true;
    var start;
    try {
      var fromHash = parseHashPage();
      if (fromHash) {
        start = Promise.resolve(fromHash);
      } else {
        start = loadDefaultPage().then(function (page) {
          writePageHash(page, true);
          return page;
        });
      }
    } catch (err) {
      showFatal(err);
      booting = false;
      return;
    }

    start
      .then(function (page) {
        setPage(page);
        build();
        refreshSkinLinks();
        booting = false;
      })
      .catch(function (err) {
        showFatal(err);
        booting = false;
      });
  }

  boot();
})();
