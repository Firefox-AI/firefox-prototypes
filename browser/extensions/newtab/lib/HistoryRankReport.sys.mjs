const REPORT_STYLE = `
  :root { color-scheme: light dark; font: 14px system-ui, sans-serif; }
  body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
  h1, h2 { margin: 0 0 12px; }
  h2 { margin-top: 28px; }
  .summary { margin-bottom: 20px; color: GrayText; }
  .histograms { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .histogram { border: 1px solid GrayText; border-radius: 8px; padding: 12px; }
  .histogram-row { display: grid; gap: 4px; grid-template-columns: 72px 1fr; margin: 5px 0; }
  .histogram-label { font-variant-numeric: tabular-nums; }
  .bar { min-height: 8px; border-radius: 2px; }
  .merino { background: #e67e22; opacity: .45; }
  .cosine { background: #3498db; opacity: .45; }
  .legend { color: GrayText; font-size: 12px; margin-top: 8px; }
  .legend span { margin-right: 14px; }
  .legend .swatch { display: inline-block; height: 10px; margin-right: 4px; width: 10px; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; min-width: 1100px; width: 100%; }
  th, td { border-bottom: 1px solid GrayText; padding: 8px; text-align: left; vertical-align: top; }
  th { position: sticky; top: 0; background: Canvas; }
  .rank, .score { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .article { display: flex; gap: 10px; min-width: 360px; }
  .article img { flex: 0 0 96px; height: 64px; object-fit: cover; }
  .article-title { font-weight: 600; }
  .excerpt { color: GrayText; margin-top: 4px; }
  .url { color: GrayText; font-size: 12px; overflow-wrap: anywhere; margin-top: 4px; }
`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function numberValue(value) {
  let number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayNumber(value) {
  let number = numberValue(value);
  return number === null ? "" : String(number);
}

function rankItems(items, sections) {
  let sectionRanks = new Map(
    sections.map((section, index) => [section.sectionKey, index])
  );
  let rows = items.map((item, index) => ({
    item,
    index,
    cosineScore: numberValue(item.cosine_similarity),
  }));
  let originalRows = rows.slice().sort((a, b) => {
    let aSection =
      a.item.section === undefined || a.item.section === null
        ? -1
        : (sectionRanks.get(a.item.section) ?? sections.length);
    let bSection =
      b.item.section === undefined || b.item.section === null
        ? -1
        : (sectionRanks.get(b.item.section) ?? sections.length);
    if (aSection != bSection) {
      return aSection - bSection;
    }
    let aRank = numberValue(a.item.received_rank);
    let bRank = numberValue(b.item.received_rank);
    if (aRank !== null && bRank !== null && aRank != bRank) {
      return aRank - bRank;
    }
    if (aRank === null && bRank !== null) {
      return 1;
    }
    if (aRank !== null && bRank === null) {
      return -1;
    }
    return a.index - b.index;
  });
  originalRows.forEach((row, index) => {
    row.merinoRank = index + 1;
  });

  rows.sort((a, b) => {
    if (a.cosineScore !== null && b.cosineScore !== null) {
      if (a.cosineScore != b.cosineScore) {
        return b.cosineScore - a.cosineScore;
      }
    } else if (a.cosineScore !== null) {
      return -1;
    } else if (b.cosineScore !== null) {
      return 1;
    }
    return a.merinoRank - b.merinoRank;
  });
  rows.forEach((row, index) => {
    row.cosineRank = index + 1;
  });
  return rows;
}

function renderHistogram(topic, rows, maxRank) {
  let binCount = Math.min(10, Math.max(1, maxRank));
  let merinoCounts = Array(binCount).fill(0);
  let cosineCounts = Array(binCount).fill(0);
  let rankToBin = rank =>
    Math.min(binCount - 1, Math.floor(((rank - 1) * binCount) / maxRank));

  for (let row of rows) {
    merinoCounts[rankToBin(row.merinoRank)]++;
    cosineCounts[rankToBin(row.cosineRank)]++;
  }
  let maxCount = Math.max(...merinoCounts, ...cosineCounts, 1);
  let histogramRows = merinoCounts.map((count, index) => {
    let start = Math.floor((index * maxRank) / binCount) + 1;
    let end = Math.floor(((index + 1) * maxRank) / binCount);
    let merinoWidth = (count / maxCount) * 100;
    let cosineWidth = (cosineCounts[index] / maxCount) * 100;
    return `<div class="histogram-row">
      <span class="histogram-label">${start}-${end}</span>
      <div>
        <div class="bar merino" style="width:${merinoWidth}%" title="Merino: ${count}"></div>
        <div class="bar cosine" style="width:${cosineWidth}%" title="Cosine: ${cosineCounts[index]}"></div>
      </div>
    </div>`;
  });

  return `<div class="histogram">
    <strong>${escapeHtml(topic)}</strong>
    ${histogramRows.join("")}
  </div>`;
}

function renderArticle(row) {
  let item = row.item;
  let title = item.title || item.url || "Untitled article";
  let link = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`
    : escapeHtml(title);
  let image = item.raw_image_src
    ? `<img loading="lazy" src="${escapeHtml(item.raw_image_src)}" alt="">`
    : "";
  let excerpt = item.excerpt
    ? `<div class="excerpt">${escapeHtml(item.excerpt)}</div>`
    : "";
  let url = item.url ? `<div class="url">${escapeHtml(item.url)}</div>` : "";
  return `<div class="article">
    ${image}
    <div><div class="article-title">${link}</div>${excerpt}${url}</div>
  </div>`;
}

export function buildHistoryRankReport(items, sections = []) {
  let rows = rankItems(items, sections);
  let topics = new Map();
  for (let row of rows) {
    let topic = row.item.topic || "untagged";
    let topicRows = topics.get(topic) || [];
    topicRows.push(row);
    topics.set(topic, topicRows);
  }
  let histograms = [...topics.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, topicRows]) =>
      renderHistogram(topic, topicRows, rows.length)
    );
  let tableRows = rows.map(row => {
    let item = row.item;
    return `<tr>
      <td class="rank">${row.cosineRank}</td>
      <td class="rank">${row.merinoRank}</td>
      <td class="score">${escapeHtml(displayNumber(row.cosineScore))}</td>
      <td class="score">${escapeHtml(displayNumber(item.server_score))}</td>
      <td>${escapeHtml(item.section || "")}</td>
      <td>${escapeHtml(item.topic || "untagged")}</td>
      <td>${renderArticle(row)}</td>
    </tr>`;
  });
  let generatedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Firefox New Tab History Rank</title>
  <style>${REPORT_STYLE}</style>
</head>
<body>
  <h1>Firefox New Tab History Rank</h1>
  <div class="summary">Generated ${escapeHtml(generatedAt)} · ${rows.length} articles · sorted by raw cosine similarity</div>
  <h2>Rank distributions by topic</h2>
  <div class="histograms">${histograms.join("")}</div>
  <div class="legend">
    <span><span class="swatch merino"></span>Merino rank</span>
    <span><span class="swatch cosine"></span>Cosine rank</span>
  </div>
  <h2>Articles</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Cosine rank</th><th>Merino rank</th><th>Cosine score</th>
        <th>Server score</th><th>Section</th><th>Topic</th><th>Article</th>
      </tr></thead>
      <tbody>${tableRows.join("")}</tbody>
    </table>
  </div>
</body>
</html>
`;
}
