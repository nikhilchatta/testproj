import Anthropic from "@anthropic-ai/sdk";
import express, { Request, Response } from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewIssue {
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  message: string;
  line?: number;
  endLine?: number;
  column?: number;
  endColumn?: number;
  suggestion?: string;
}

interface ReviewResult {
  file: string;
  score: number; // 0-100, higher is better
  issues: ReviewIssue[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    py: "Python",
    scala: "Scala",
    sql: "SQL",
    tf: "Terraform (HCL)",
  };
  return map[ext ?? ""] ?? "unknown";
}

// ---------------------------------------------------------------------------
// Route: POST /api/review
// Body: { file: string, content: string }
// ---------------------------------------------------------------------------

app.post("/api/review", async (req: Request, res: Response) => {
  const { file, content } = req.body as { file?: string; content?: string };

  if (!file || !content) {
    res.status(400).json({ error: "file and content are required" });
    return;
  }

  const language = detectLanguage(file);

  const systemPrompt = `You are an expert ${language} code reviewer.
Analyze the code for:
- Security vulnerabilities (SQL injection, secrets in code, insecure permissions, etc.)
- Bugs and logic errors
- Performance issues
- Code quality and maintainability
- Best-practice violations specific to ${language}

Respond ONLY with valid JSON matching this exact schema (no markdown fences):
{
  "score": <integer 0-100, where 100 is perfect code>,
  "summary": "<one-sentence overall assessment>",
  "issues": [
    {
      "ruleId": "<short-kebab-case-id>",
      "severity": "<critical|high|medium|low|info>",
      "message": "<clear description of the problem>",
      "line": <1-based line number or null>,
      "endLine": <1-based end line or null>,
      "column": <1-based column or null>,
      "endColumn": <1-based end column or null>,
      "suggestion": "<concrete fix suggestion>"
    }
  ]
}`;

  const userPrompt = `Review this ${language} file: ${file}\n\n\`\`\`${language.toLowerCase()}\n${content}\n\`\`\``;

  try {
    const message = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
    });

    const raw =
      message.content[0].type === "text" ? message.content[0].text : "";

    // Strip any accidental markdown fences
    const jsonText = raw.replace(/^```[a-z]*\n?/gm, "").replace(/^```$/gm, "").trim();
    const parsed = JSON.parse(jsonText) as Omit<ReviewResult, "file">;

    const result: ReviewResult = { file, ...parsed };
    res.json(result);
  } catch (err) {
    console.error("Review error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Route: GET /api/health
// ---------------------------------------------------------------------------

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 5001);
app.listen(PORT, () => {
  console.log(`AI Code Review server listening on http://localhost:${PORT}`);
});
