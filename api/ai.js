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

    const { provider, prompt } = body;

    if (!provider || !["gemini", "groq"].includes(provider)) {
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

    if (provider === "gemini") {
      return await callGemini(prompt, res);
    }

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

    console.error("Gemini upstream error:", response.status, text);

    return res.status(502).json({
      error: "Gemini request failed.",
      status: response.status,
    });
  }

  const json = await response.json();

  const text =
    json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    return res.status(502).json({
      error: "Gemini returned no content.",
    });
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return res.status(502).json({
      error: "Gemini returned invalid JSON.",
    });
  }

  return res.status(200).json({ data });
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

    console.error("Groq upstream error:", response.status, text);

    return res.status(502).json({
      error: "Groq request failed.",
      status: response.status,
    });
  }

  const json = await response.json();

  const text =
    json?.choices?.[0]?.message?.content;

  if (!text) {
    return res.status(502).json({
      error: "Groq returned no content.",
    });
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    return res.status(502).json({
      error: "Groq returned invalid JSON.",
    });
  }

  return res.status(200).json({ data });
}