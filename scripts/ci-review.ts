/**
 * ci-review.ts
 *
 * CLI entry point for the AI code review step in GitHub Actions.
 *
 * Usage:
 *   npx tsx scripts/ci-review.ts [options] <file1> <file2> ...
 *
 * Options:
 *   --threshold <n>         Minimum quality score (0-100). Fails if any file scores below this.
 *   --fail-on-critical      Exit non-zero if any critical issue is found.
 *   --fail-on-high          Exit non-zero if any high-severity issue is found.
 *   --format sarif          Output format (currently only "sarif" is supported).
 *   --output <path>         Where to write the SARIF file.
 */

import fs from "fs";
import path from "path";
import http from "http";

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
  score: number;
  issues: ReviewIssue[];
  summary: string;
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: {
        startLine: number;
        endLine: number;
        startColumn: number;
        endColumn: number;
      };
    };
  }[];
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  files: string[];
  threshold: number;
  failOnCritical: boolean;
  failOnHigh: boolean;
  format: string;
  output: string;
} {
  const args = argv.slice(2);
  const files: string[] = [];
  let threshold = 0;
  let failOnCritical = false;
  let failOnHigh = false;
  let format = "sarif";
  let output = "code-review-results.sarif";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--threshold") {
      threshold = parseInt(args[++i] ?? "0", 10);
    } else if (arg === "--fail-on-critical") {
      failOnCritical = true;
    } else if (arg === "--fail-on-high") {
      failOnHigh = true;
    } else if (arg === "--format") {
      format = args[++i] ?? "sarif";
    } else if (arg === "--output") {
      output = args[++i] ?? output;
    } else if (!arg.startsWith("--")) {
      files.push(arg);
    }
  }

  return { files, threshold, failOnCritical, failOnHigh, format, output };
}

// ---------------------------------------------------------------------------
// HTTP helper — call the local review server
// ---------------------------------------------------------------------------

function reviewFile(
  apiUrl: string,
  file: string,
  content: string
): Promise<ReviewResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ file, content });
    const url = new URL(`${apiUrl}/review`);

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port ? parseInt(url.port) : 5001,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Server returned ${res.statusCode}: ${data}`));
            return;
          }
          resolve(JSON.parse(data) as ReviewResult);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SARIF builder
// ---------------------------------------------------------------------------

function severityToSarifLevel(severity: ReviewIssue["severity"]): string {
  switch (severity) {
    case "critical":
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "note";
  }
}

function buildSarif(results: ReviewResult[]): object {
  const rules = new Map<string, { id: string; name: string; help: string }>();
  const sarifResults: SarifResult[] = [];

  for (const result of results) {
    for (const issue of result.issues) {
      if (!rules.has(issue.ruleId)) {
        rules.set(issue.ruleId, {
          id: issue.ruleId,
          name: issue.ruleId
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" "),
          help: issue.suggestion ?? issue.message,
        });
      }

      sarifResults.push({
        ruleId: issue.ruleId,
        level: severityToSarifLevel(issue.severity),
        message: {
          text: `[${issue.severity.toUpperCase()}] ${issue.message}${
            issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ""
          }`,
        },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: result.file },
              region: {
                startLine: issue.line ?? 1,
                endLine: issue.endLine ?? issue.line ?? 1,
                startColumn: issue.column ?? 1,
                endColumn: issue.endColumn ?? issue.column ?? 1,
              },
            },
          },
        ],
      });
    }
  }

  return {
    $schema:
      "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "AI Code Review",
            version: "1.0.0",
            informationUri: "https://github.com/nikhilchatta/testproj",
            rules: Array.from(rules.values()).map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.name },
              fullDescription: { text: r.help },
              helpUri:
                "https://github.com/nikhilchatta/testproj/blob/master/README.md",
              help: { text: r.help },
            })),
          },
        },
        results: sarifResults,
        artifacts: results.map((r) => ({
          location: { uri: r.file },
        })),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { files, threshold, failOnCritical, failOnHigh, output } =
    parseArgs(process.argv);

  const apiUrl = process.env.CODE_REVIEW_API_URL ?? "http://localhost:5001/api";

  if (files.length === 0) {
    console.log("No files to review.");
    process.exit(0);
  }

  console.log(`Reviewing ${files.length} file(s) via ${apiUrl}...`);

  const results: ReviewResult[] = [];
  let hasCritical = false;
  let hasHigh = false;
  let belowThreshold = false;

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`  [SKIP] ${file} — file not found`);
      continue;
    }

    const content = fs.readFileSync(file, "utf-8");
    console.log(`  Reviewing ${file}...`);

    try {
      const result = await reviewFile(apiUrl, file, content);
      results.push(result);

      const issueCount = result.issues.length;
      console.log(
        `    Score: ${result.score}/100  Issues: ${issueCount}  — ${result.summary}`
      );

      if (result.score < threshold) {
        console.error(
          `    FAIL: score ${result.score} is below threshold ${threshold}`
        );
        belowThreshold = true;
      }

      for (const issue of result.issues) {
        const loc = issue.line ? `:${issue.line}` : "";
        console.log(
          `    [${issue.severity.toUpperCase()}] ${file}${loc} — ${issue.message}`
        );
        if (issue.severity === "critical") hasCritical = true;
        if (issue.severity === "high") hasHigh = true;
      }
    } catch (err) {
      console.error(`    ERROR reviewing ${file}:`, err);
      // Do not fail the whole job on a single file error; still write SARIF.
    }
  }

  // Write SARIF output
  const sarif = buildSarif(results);
  const outputPath = path.resolve(output);
  fs.writeFileSync(outputPath, JSON.stringify(sarif, null, 2), "utf-8");
  console.log(`\nSARIF results written to ${outputPath}`);

  // Summary
  const totalIssues = results.reduce((s, r) => s + r.issues.length, 0);
  const avgScore =
    results.length > 0
      ? Math.round(results.reduce((s, r) => s + r.score, 0) / results.length)
      : 100;

  console.log(`\n=== Review Summary ===`);
  console.log(`Files reviewed : ${results.length}`);
  console.log(`Average score  : ${avgScore}/100`);
  console.log(`Total issues   : ${totalIssues}`);

  // Exit code logic
  if (failOnCritical && hasCritical) {
    console.error("FAIL: critical issues found (--fail-on-critical)");
    process.exit(1);
  }
  if (failOnHigh && hasHigh) {
    console.error("FAIL: high-severity issues found (--fail-on-high)");
    process.exit(1);
  }
  if (belowThreshold) {
    console.error(`FAIL: one or more files scored below threshold ${threshold}`);
    process.exit(1);
  }

  console.log("Code review passed.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
