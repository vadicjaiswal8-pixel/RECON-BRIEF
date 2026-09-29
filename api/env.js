const requiredEnv = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
};

export const env = {
  geminiApiKey: requiredEnv("GEMINI_API_KEY"),
  groqApiKey: requiredEnv("GROQ_API_KEY"),
  tavilyApiKey: requiredEnv("TAVILY_API_KEY"),
};