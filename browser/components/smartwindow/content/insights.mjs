import { html, css } from "chrome://global/content/vendor/lit.all.mjs";

/**
 * User insights data organized by category
 */
export const INSIGHTS_DATA = {
  "Health & Wellness": [
    "mental wellness",
    "Headspace",
    "nutrition tracking",
    "MyFitnessPal",
    "Healthline",
    "pediatric resources",
    "KidsHealth",
    "BabyCenter",
    "holistic health",
    "WebMD",
  ],
  "Food & Cooking": [
    "healthy recipes",
    "family-friendly recipes",
    "EatingWell",
    "Cooking Light",
    "meal planning",
    "savory pies",
    "quick recipes",
    "seasonal cooking",
  ],
  "Shopping & Deals": [
    "deal-seeking behavior",
    "RetailMeNot",
    "CouponCabin",
    "grocery shopping",
    "Walmart",
    "Costco",
    "budget-conscious purchases",
    "comparison shopping",
    "Amazon",
    "eBay",
  ],
  "Parenting & Family": [
    "child development",
    "family activities",
    "pregnancy resources",
    "BabyCenter",
    "WhatToExpect",
    "family-oriented meal planning",
  ],
  "Travel & Outdoor": [
    "SJC",
    "family-friendly trips",
    "hiking trails",
    "AllTrails",
    "REI",
    "Airbnb",
    "road trips",
    "outdoor gear research",
  ],
  "Fashion & Lifestyle": [
    "minimalist fashion",
    "sustainable fashion",
    "white t-shirts",
    "jeans",
    "ASOS",
    "Zara",
    "luxury brands",
    "Chanel",
    "Gucci",
    "affordable clothing",
  ],
  "Entertainment & Media": [
    "pop music playlists",
    "streaming",
    "Netflix",
    "Hulu",
    "Disney+",
    "movie theaters",
    "movie reviews",
    "IMDb",
    "Rotten Tomatoes",
    "anime",
    "news",
    "CNN",
    "BBC",
  ],
  "Productivity & Work": [
    "Google Workspace",
    "Trello",
    "Notion",
    "LinkedIn",
    "networking",
    "workflow optimization",
  ],
  "Academic & Research": [
    "scholarly resources",
    "Google Scholar",
    "JSTOR",
    "Coursera",
    "edX",
    "self-learning",
    "Khan Academy",
    "STEM focus",
    "biology",
    "engineering scholarships",
  ],
  "Home Improvement & DIY": [
    "interior design",
    "Houzz",
    "repairs",
    "Home Depot",
    "Lowe's",
    "organization projects",
  ],
  "Financial & Investment": [
    "market monitoring",
    "Yahoo Finance",
    "Bloomberg",
    "personal finance",
    "investment research",
  ],
  Other: [
    "book reading",
    "Goodreads",
    "local services",
    "Yelp",
    "cafes",
    "restaurants",
    "photography gear",
    "Sony cameras",
    "environmental awareness",
  ],
};

/**
 * Builds the system prompt with insights data
 */
export function buildInsightsSystemPrompt() {
  let systemPrompt = `

When responding, if you use any user insights from the list below to personalize your response (even implicitly), you must reference them by including [[insight: specific term]] inline, directly after the phrase or sentence where the insight is applied. Use specific terms from the list rather than broad categories, and include multiple tags if multiple insights are relevant. This enables better personalization features—do not skip tagging if an insight influences your answer. Only tag insights you actually use; avoid tagging irrelevant ones.

User Insights List:`;

  // Build insights list from data
  Object.entries(INSIGHTS_DATA).forEach(([category, insights]) => {
    if (insights.length) {
      const insightString = insights.join(", ");
      systemPrompt += `\n- ${category}: ${insightString}.`;
    }
  });

  systemPrompt += `

Examples of Insight Tagging:
- User asks about flights: Weave in personalization like "Since you often fly from SJC [[insight: SJC]], consider direct options..."
- User asks about meals: "This recipe fits your interest in seasonal cooking [[insight: seasonal cooking]] and healthy recipes [[insight: healthy recipes]]."
- User asks about shoes: "For hiking boots, check REI [[insight: REI]] based on your outdoor gear research [[insight: outdoor gear research]]."`;

  return systemPrompt;
}

/**
 * Deletes an insight from the INSIGHTS_DATA object
 */
export function deleteInsight(insight, category) {
  if (INSIGHTS_DATA[category]) {
    const index = INSIGHTS_DATA[category].indexOf(insight);
    if (index > -1) {
      INSIGHTS_DATA[category].splice(index, 1);
      return true;
    }
  }
  return false;
}

/**
 * Detects insight tokens in content
 */
export function detectInsightTokens(content) {
  const insightRegex = /\[\[insight:\s*([^\]]+)\]\]/gi;
  const matches = [];
  let match;

  while ((match = insightRegex.exec(content)) !== null) {
    matches.push({
      fullMatch: match[0],
      insight: match[1].trim(),
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return matches;
}

/**
 * Creates a clickable insight token element
 */
export function createClickableInsightToken(insight, onInsightClick) {
  return html`
    <span
      class="insight-tag clickable"
      @click=${() => onInsightClick(insight)}
      title="Click to view all insights"
    >
      ${insight}
    </span>
  `;
}

/**
 * Creates the insights overlay component
 */
export function createInsightsOverlay(
  onClose,
  usedInsights = new Set(),
  onDeleteInsight = null
) {
  return html`
    <div class="insights-overlay" @click=${onClose}>
      <div class="insights-modal" @click=${e => e.stopPropagation()}>
        <div class="insights-header">
          <h3>
            Transparency dashboard
            ${usedInsights.size > 0
              ? html`<span class="used-count">${usedInsights.size} used</span>`
              : ""}
          </h3>
          <button class="close-btn" @click=${onClose}>×</button>
        </div>
        <div class="insights-content">
          ${Object.entries(INSIGHTS_DATA)
            .map(([category, insights]) => {
              const usedCount = insights.filter(insight =>
                usedInsights.has(insight)
              ).length;
              return { category, insights, usedCount };
            })
            .filter(({ insights }) => !!insights.length)
            .sort((a, b) => {
              // Sort by used count (descending), then alphabetically
              if (a.usedCount !== b.usedCount) {
                return b.usedCount - a.usedCount;
              }
              return a.category.localeCompare(b.category);
            })
            .map(
              ({ category, insights }) => html`
                <div class="insight-category">
                  <h4>${category}</h4>
                  <div class="insight-items">
                    ${insights.map(
                      insight => html`
                        <span
                          class="insight-item ${usedInsights.has(insight)
                            ? "used"
                            : ""}"
                          title=${usedInsights.has(insight)
                            ? "Used in this conversation"
                            : ""}
                        >
                          <span class="insight-text">${insight}</span>
                          ${onDeleteInsight
                            ? html`
                                <button
                                  class="delete-insight-btn"
                                  @click=${e => {
                                    e.stopPropagation();
                                    onDeleteInsight(insight, category);
                                  }}
                                  title="Delete this insight"
                                >
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                  >
                                    <path
                                      d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                    />
                                    <line
                                      x1="10"
                                      y1="11"
                                      x2="10"
                                      y2="17"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                    />
                                    <line
                                      x1="14"
                                      y1="11"
                                      x2="14"
                                      y2="17"
                                      stroke="currentColor"
                                      stroke-width="2"
                                      stroke-linecap="round"
                                    />
                                  </svg>
                                </button>
                              `
                            : ""}
                        </span>
                      `
                    )}
                  </div>
                </div>
              `
            )}
        </div>
      </div>
    </div>
  `;
}

/**
 * CSS styles for insights functionality
 */
export const insightsStyles = css`
  .insight-tag {
    font-size: 0.75rem;
    background: #e8f4fd;
    color: #0066cc;
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    border: 1px solid #b3d7f2;
  }

  .insight-tag.clickable {
    cursor: pointer;
    transition: all 0.2s;
  }

  .insight-tag.clickable:hover {
    background: #d4edfc;
    border-color: #8cc8ea;
    transform: translateY(-1px);
  }

  .insights-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .insights-modal {
    background: white;
    border-radius: 8px;
    max-width: 800px;
    max-height: 80vh;
    width: 90%;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  }

  .insights-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f8f9fa;
  }

  .insights-header h3 {
    margin: 0;
    color: #333;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .used-count {
    font-size: 0.75rem;
    font-weight: 500;
    background: #e8f4fd;
    color: #0066cc;
    padding: 0.25rem 0.5rem;
    border-radius: 12px;
    border: 1px solid #b3d7f2;
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
  }

  .close-btn:hover {
    background: #e0e0e0;
  }

  .insights-content {
    padding: 1.5rem;
    max-height: 60vh;
    overflow-y: auto;
  }

  .insight-category {
    margin-bottom: 1.5rem;
  }

  .insight-category:last-child {
    margin-bottom: 0;
  }

  .insight-category h4 {
    margin: 0 0 0.75rem 0;
    color: #0066cc;
    font-weight: 600;
    border-bottom: 2px solid #e8f4fd;
    padding-bottom: 0.25rem;
  }

  .insight-items {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .insight-item {
    font-size: 0.75rem;
    background: #f0f0f0;
    color: #333;
    padding: 0.25rem 0.5rem;
    border-radius: 8px;
    border: 1px solid #d0d0d0;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    position: relative;
  }

  .insight-item:hover {
    background: #e8e8e8;
  }

  .insight-item.used {
    background: #e8f4fd;
    color: #0066cc;
    border-color: #b3d7f2;
    font-weight: 600;
    box-shadow: 0 2px 4px rgba(0, 102, 204, 0.1);
  }

  .insight-item.used:hover {
    background: #d4edfc;
  }

  .insight-text {
    flex: 1;
  }

  .delete-insight-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: #666;
    padding: 0.25rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: all 0.2s;
    margin: 0;
  }

  .insight-item:hover .delete-insight-btn {
    opacity: 1;
  }

  .delete-insight-btn:hover {
    background: #ff4444;
    color: white;
  }

  .used-insights {
    margin-top: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .insights-label {
    font-size: 0.75rem;
    color: #666;
    font-weight: 500;
  }
`;
