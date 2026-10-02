import { buildHistoryRankReport } from "lib/HistoryRankReport.sys.mjs";

describe("HistoryRankReport", () => {
  it("sorts the report globally by cosine score and preserves feed metadata", () => {
    let html = buildHistoryRankReport(
      [
        {
          title: "lower cosine",
          excerpt: "excerpt",
          section: "first",
          topic: "science",
          received_rank: 0,
          cosine_similarity: 0.2,
          server_score: 0.4,
          url: "https://example.com/lower",
        },
        {
          title: "higher cosine",
          section: "second",
          topic: "science",
          received_rank: 0,
          cosine_similarity: 0.9,
          server_score: 0.8,
          url: "https://example.com/higher",
        },
      ],
      [{ sectionKey: "first" }, { sectionKey: "second" }]
    );

    expect(html.indexOf("higher cosine")).toBeLessThan(
      html.indexOf("lower cosine")
    );
    expect(html).toContain("Cosine rank");
    expect(html).toContain("Merino rank");
    expect(html).toContain("0.9");
    expect(html).toContain("0.8");
    expect(html).toContain("science");
    expect(html).toContain("https://example.com/higher");
  });
});
