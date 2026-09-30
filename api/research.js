import { env } from "./env.js";

const MAX_QUERY_LENGTH = 1000;
const MAX_RESULTS = 10;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const { query, maxResults = 5 } = body;

    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({
        error: "A non-empty query is required.",
      });
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(413).json({
        error: "Query is too long.",
      });
    }

    const safeMaxResults = Math.min(
      Math.max(Number(maxResults) || 5, 1),
      MAX_RESULTS
    );

    const response = await fetch("https://api.tavily.com/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.tavilyApiKey}`,
  },
  body: JSON.stringify({
    query: query.trim(),
    max_results: safeMaxResults,
    include_raw_content: true,
  }),
});

    if (!response.ok) {
      const text = await response.text();

      console.error(
        "Tavily upstream error:",
        response.status,
        text
      );

      return res.status(502).json({
        error: "Tavily request failed.",
        status: response.status,
      });
    }

    const json = await response.json();

    return res.status(200).json({
      results: Array.isArray(json.results) ? json.results : [],
    });
  } catch (error) {
    console.error("Research API error:", error);

    return res.status(500).json({
      error: "Research request failed.",
    });
  }
}