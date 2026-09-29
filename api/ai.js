import { env } from "./env.js";

const MAX_PROMPT_LENGTH = 120000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const { provider = "gemini", prompt } = body;

    if (!["gemini", "groq"].includes(provider)) {
      return res.status(400).json({
        error: "Invalid provider. Use gemini or groq.",
      });
    }

    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({
        error: "A non-empty prompt is required.",
      });
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(413).json({
        error: "Prompt is too large.",
      });
    }

    // If Gemini is requested, try Gemini first.
    // If Gemini fails, automatically fall back to Groq.
    if (provider === "gemini") {
      try {
        return await callGemini(prompt, res);
      } catch (geminiError) {
        console.error(
          "Gemini failed. Falling back to Groq:",
          geminiError
        );

        try {
          return await callGroq(prompt, res);
        } catch (groqError) {
          console.error(
            "Groq fallback also failed:",
            groqError
          );

          return res.status(502).json({
            error: "Both primary and backup AI providers failed.",
          });
        }
      }
    }

    // Direct Groq request.
    return await callGroq(prompt, res);
  } catch (error) {
    console.error("AI API error:", error);

    return res.status(500).json({
      error: "AI request failed.",
    });
  }
}

async function callGemini(prompt, res) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    "gemini-3.8-flash:generateContent";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();

    console.error(
      "Gemini upstream error:",
      response.status,
      text
    );

    throw new Error(
      `Gemini request failed with status ${response.status}`
    );
  }

  const json = await response.json();

  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned no content.");
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }

  return res.status(200).json({
    data,
    provider: "gemini",
  });
}

async function callGroq(prompt, res) {
  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.groqApiKey}`,
      },
      body: JSON.stringify({
        model:
          process.env.GROQ_MODEL ||
          "openai/gpt-oss-120b",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: {
          type: "json_object",
        },
        reasoning_effort: "low",
        max_tokens: 5000,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();

    console.error(
      "Groq upstream error:",
      response.status,
      text
    );

    throw new Error(
      `Groq request failed with status ${response.status}`
    );
  }

  const json = await response.json();

  const text =
    json?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error("Groq returned no content.");
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Groq returned invalid JSON.");
  }

  return res.status(200).json({
    data,
    provider: "groq",
  });
}