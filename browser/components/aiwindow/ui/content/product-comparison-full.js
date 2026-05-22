/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Note: chrome:// XHTML pages strip <button>/<input> when assigned via
// innerHTML, so all interactive elements are constructed with
// document.createElement. innerHTML is OK for static markup (no buttons).

function decodeFragment() {
  const hash = window.location.hash || "";
  const m = hash.match(/data=([^&]+)/);
  if (!m) {
    return null;
  }
  try {
    const json = decodeURIComponent(escape(atob(m[1])));
    return JSON.parse(json);
  } catch (e) {
    console.error("[pcf] failed to decode fragment payload", e);
    return null;
  }
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "class") {
        node.className = v;
      } else if (k === "text") {
        node.textContent = v;
      } else if (k === "html") {
        node.innerHTML = v;
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  if (children) {
    const list = Array.isArray(children) ? children : [children];
    for (const c of list) {
      if (c == null) {
        continue;
      }
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

function formatPrice(price) {
  if (!price || typeof price.amount !== "number" || price.amount <= 0) {
    return "—";
  }
  return `$${Math.round(price.amount).toLocaleString()}`;
}

function renderRating(rating) {
  if (!rating || typeof rating.value !== "number") {
    return el("span", { class: "pcf-rating-empty", text: "—" });
  }
  const stars = Math.round(rating.value);
  const filled = "★".repeat(Math.max(0, Math.min(5, stars)));
  const empty = "☆".repeat(Math.max(0, 5 - stars));
  const wrap = el("span", { class: "pcf-rating" });
  wrap.appendChild(
    el("span", {
      class: "pcf-rating-stars",
      "aria-hidden": "true",
      text: filled + empty,
    })
  );
  wrap.appendChild(
    el("span", { class: "pcf-rating-value", text: rating.value.toFixed(1) })
  );
  if (typeof rating.count === "number") {
    wrap.appendChild(
      el("span", { class: "pcf-rating-count", text: `(${rating.count})` })
    );
  }
  return wrap;
}

function renderImage(p) {
  if (!p.imageUrl) {
    return el("div", { class: "pcf-image-fallback", text: "▢" });
  }
  const img = el("img", {
    src: p.imageUrl,
    alt: `${p.brand || ""} ${p.name || "product"}`.trim(),
    referrerpolicy: "no-referrer",
    loading: "lazy",
  });
  img.addEventListener("error", () => {
    const fb = el("div", { class: "pcf-image-fallback", text: "▢" });
    img.replaceWith(fb);
  });
  return img;
}

function renderProductHeaderCell(product, isRec, rationale) {
  const th = el("th", {
    class: "pcf-product-header" + (isRec ? " pcf-recommended" : ""),
    scope: "col",
  });
  if (isRec) {
    th.appendChild(
      el("div", { class: "pcf-recommend-tag", text: "Recommended" })
    );
  }
  th.appendChild(el("h3", { class: "pcf-product-title", text: product.name }));
  const brandLine = el("div", {
    class: "pcf-product-brand",
    text: (product.brand || "—") +
      (product.retailer ? ` · ${product.retailer}` : ""),
  });
  if (product.pinned) {
    brandLine.appendChild(
      el("span", { class: "pcf-pinned-chip", text: "From your tab" })
    );
  }
  th.appendChild(brandLine);
  if (isRec && rationale) {
    th.appendChild(
      el("div", {
        class: "pcf-rationale",
        text: rationale,
      })
    );
  }
  return th;
}

function renderSpecList(specs) {
  if (!specs?.length) {
    return el("td", { text: "—" });
  }
  const ul = el("ul", { class: "pcf-spec-list" });
  for (const s of specs.slice(0, 8)) {
    const li = el("li");
    li.appendChild(el("span", { class: "pcf-spec-key", text: s.label }));
    li.appendChild(el("span", { class: "pcf-spec-value", text: s.value }));
    ul.appendChild(li);
  }
  return el("td", null, ul);
}

function renderListCell(items) {
  if (!items?.length) {
    return el("td", { text: "—" });
  }
  const ul = el("ul", { class: "pcf-spec-list" });
  for (const item of items) {
    ul.appendChild(el("li", { text: item }));
  }
  return el("td", null, ul);
}

function renderActionsCell(product, idx, onPreview) {
  const td = el("td");
  const wrap = el("div", { class: "pcf-actions" });
  const btn = el("button", {
    class: "pcf-btn pcf-btn-primary",
    type: "button",
    text: "Preview here",
  });
  btn.addEventListener("click", () => onPreview(product, idx));
  wrap.appendChild(btn);
  const link = el("a", {
    class: "pcf-btn",
    href: product.productUrl,
    target: "_blank",
    rel: "noopener",
    text: "Open in new tab",
  });
  wrap.appendChild(link);
  td.appendChild(wrap);
  return td;
}

function buildTable(products, recommendationId, rationale, onPreview) {
  const table = el("table", { class: "pcf-table" });

  // Header row: empty cell + product header cells
  const thead = el("thead");
  const headTr = el("tr");
  headTr.appendChild(
    el("th", { class: "pcf-row-label", scope: "col", html: "&nbsp;" })
  );
  for (const p of products) {
    headTr.appendChild(
      renderProductHeaderCell(p, p.id === recommendationId, rationale)
    );
  }
  thead.appendChild(headTr);
  table.appendChild(thead);

  // Body rows
  const tbody = el("tbody");
  const addRow = (label, cellMaker) => {
    const tr = el("tr");
    tr.appendChild(
      el("th", { class: "pcf-row-label", scope: "row", text: label })
    );
    products.forEach((p, i) => tr.appendChild(cellMaker(p, i)));
    tbody.appendChild(tr);
  };

  addRow("Image", p => {
    const td = el("td", { class: "pcf-image-cell" });
    td.appendChild(renderImage(p));
    return td;
  });
  addRow("Price", p => {
    const td = el("td");
    td.appendChild(el("span", { class: "pcf-price", text: formatPrice(p.price) }));
    return td;
  });
  addRow("Rating", p => {
    const td = el("td");
    td.appendChild(renderRating(p.rating));
    return td;
  });
  addRow("Key specs", p => renderSpecList(p.specs));
  addRow("Review summary", p => {
    const td = el("td");
    td.appendChild(
      el("p", {
        class: "pcf-review-summary",
        text: p.reviewSummary || "—",
      })
    );
    return td;
  });
  addRow("Pros", p => renderListCell(p.pros));
  addRow("Cons", p => renderListCell(p.cons));
  addRow("Source", p => {
    let host = p.retailer || "";
    try {
      host = new URL(p.productUrl).hostname.replace(/^www\./, "");
    } catch {}
    const td = el("td");
    td.appendChild(
      el("a", {
        href: p.productUrl,
        target: "_blank",
        rel: "noopener",
        text: host,
      })
    );
    return td;
  });
  addRow("View page", (p, i) => renderActionsCell(p, i, onPreview));

  table.appendChild(tbody);
  return table;
}

function showPreview(product) {
  const preview = document.getElementById("pcf-preview");
  const frame = document.getElementById("pcf-preview-frame");
  const title = document.getElementById("pcf-preview-title");
  const blocked = document.getElementById("pcf-preview-blocked");
  const fallback = document.getElementById("pcf-preview-fallback");
  preview.removeAttribute("hidden");
  title.textContent =
    product.name + (product.retailer ? " — " + product.retailer : "");
  blocked.setAttribute("hidden", "hidden");
  frame.style.display = "";

  const url = product.productUrl;
  let blockedTimer = null;
  let loaded = false;

  const showBlocked = () => {
    if (loaded) {
      return;
    }
    blocked.removeAttribute("hidden");
    frame.style.display = "none";
  };

  frame.onload = () => {
    loaded = true;
    if (blockedTimer) {
      clearTimeout(blockedTimer);
    }
    try {
      const cw = frame.contentWindow;
      if (!cw) {
        showBlocked();
      }
    } catch {}
  };

  frame.onerror = showBlocked;
  blockedTimer = setTimeout(showBlocked, 4500);
  frame.src = url;
  fallback.onclick = () => window.open(url, "_blank");

  preview.scrollIntoView({ behavior: "smooth", block: "start" });
}

function init() {
  const data = decodeFragment();
  const wrap = document.getElementById("pcf-table-wrap");
  if (!data || !Array.isArray(data.products) || !data.products.length) {
    wrap.textContent =
      "No comparison data available. Open this view from the Smart Window after running a product comparison.";
    return;
  }
  document.getElementById("pcf-summary-query").textContent = data.query
    ? `Query: ${data.query}`
    : "";
  document.getElementById("pcf-summary-count").textContent =
    `${data.products.length} product${data.products.length === 1 ? "" : "s"}`;

  // Clear loading and append new content via DOM ops
  while (wrap.firstChild) {
    wrap.removeChild(wrap.firstChild);
  }
  if (data.searchSource && data.searchSource !== "web") {
    wrap.appendChild(
      el("div", {
        class: "pcf-source-banner",
        text:
          data.searchSource === "canned-bike-seat"
            ? "Note: web search returned no usable live results — showing curated bike-seat data."
            : "Note: web search returned no usable live results — showing AI-estimated picks.",
      })
    );
  }
  wrap.appendChild(
    buildTable(
      data.products,
      data.recommendationId,
      data.recommendationRationale,
      showPreview
    )
  );

  document.getElementById("pcf-preview-close").addEventListener("click", () => {
    document.getElementById("pcf-preview").setAttribute("hidden", "hidden");
    document.getElementById("pcf-preview-frame").src = "about:blank";
  });

  document.getElementById("pcf-preview-newtab").addEventListener("click", () => {
    const frame = document.getElementById("pcf-preview-frame");
    if (frame.src && frame.src !== "about:blank") {
      window.open(frame.src, "_blank");
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
