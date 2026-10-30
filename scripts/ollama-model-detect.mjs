// Detects models already installed in a local Ollama daemon and emits a
// routing config that maps OpenSEO agent task tiers (tool-calling repo work
// vs. quick classification) onto the best available model, with a fallback
// chain when a preferred model isn't installed.
//
// Intended for the Ubuntu VPS workflow where Cairn (https://github.com/cairn-dev/cairn)
// is pointed at Ollama's OpenAI-compatible endpoint (`${OLLAMA_BASE_URL}/v1`)
// instead of a hosted provider. This script does not talk to Cairn or
// hermes-agents directly — it only inspects Ollama and writes a small JSON
// config that either can read to pick a model name.
//
// Usage:
//   node scripts/ollama-model-detect.mjs                  # print a summary
//   node scripts/ollama-model-detect.mjs --json           # print the routing config as JSON
//   node scripts/ollama-model-detect.mjs --out routing.json
//   node scripts/ollama-model-detect.mjs --check          # exit non-zero if Ollama is unreachable
import { writeFileSync } from "node:fs";
import process from "node:process";
import chalk from "chalk";

const baseUrl = (
  process.env.OLLAMA_BASE_URL ||
  process.env.OLLAMA_HOST ||
  "http://127.0.0.1:11434"
).replace(/\/+$/, "");

// Ordered, most-capable-first. Matched against installed model names so
// newly pulled models of a known family are picked up automatically.
// Tool-calling reliability (multi-step MCP workflows like seo-audit or
// competitive-landscape) is the deciding factor for the "agent" tier; the
// "fast" tier is for short, single-shot classification/extraction tasks
// where a smaller model is an acceptable trade-off.
const TIER_PATTERNS = {
  agent: [
    /qwen2\.5-coder/i,
    /qwen3-coder/i,
    /devstral/i,
    /qwen3/i,
    /llama3\.3/i,
    /llama3\.1/i,
    /mistral-nemo/i,
    /mixtral/i,
  ],
  fast: [
    /qwen2\.5/i,
    /llama3\.2/i,
    /phi3/i,
    /phi4/i,
    /gemma2/i,
    /gemma3/i,
    /mistral/i,
  ],
};

// Minimum parameter count (in billions) below which a model is unlikely to
// hold up for multi-step tool calling, even if its family usually does.
const MIN_AGENT_TIER_PARAMS_B = 7;

function parseParamsB(parameterSize) {
  const match = /([\d.]+)\s*([BMK])/i.exec(parameterSize || "");
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === "B") return value;
  if (unit === "M") return value / 1000;
  return value / 1_000_000;
}

function classify(model) {
  const name = model.name || model.model || "";
  const paramsB = parseParamsB(model.details?.parameter_size);
  const tiers = new Set();
  for (const pattern of TIER_PATTERNS.agent) {
    if (pattern.test(name)) {
      if (paramsB === undefined || paramsB >= MIN_AGENT_TIER_PARAMS_B) {
        tiers.add("agent");
      }
      break;
    }
  }
  for (const pattern of TIER_PATTERNS.fast) {
    if (pattern.test(name)) {
      tiers.add("fast");
      break;
    }
  }
  // Anything installed can serve as a last-resort fallback, even if it
  // didn't match a known family.
  tiers.add("fallback");
  return { name, paramsB, tiers: [...tiers] };
}

async function fetchInstalledModels() {
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) {
    throw new Error(`Ollama returned HTTP ${response.status} from ${baseUrl}/api/tags`);
  }
  const body = await response.json();
  return Array.isArray(body.models) ? body.models : [];
}

function buildRoutingConfig(models) {
  const classified = models.map(classify);
  const byTier = (tier) =>
    classified
      .filter((model) => model.tiers.includes(tier))
      .sort((a, b) => (b.paramsB || 0) - (a.paramsB || 0))
      .map((model) => model.name);

  return {
    endpoint: `${baseUrl}/v1`,
    generatedAt: new Date().toISOString(),
    installedModels: classified.map(({ name, paramsB }) => ({ name, paramsB })),
    routing: {
      // Multi-step MCP tool-calling workflows (seo-audit, competitive-landscape, etc.).
      agent: byTier("agent"),
      // Short, single-shot classification/extraction tasks.
      fast: byTier("fast"),
      // Last resort when nothing in a preferred family is installed.
      fallback: byTier("fallback"),
    },
  };
}

function printSummary(config) {
  const { agent, fast, fallback } = config.routing;
  console.log(chalk.bold(`Ollama endpoint: ${config.endpoint}`));
  console.log(
    `  agent tier (tool-calling / repo review): ${
      agent.length ? agent.join(", ") : chalk.yellow("none detected")
    }`,
  );
  console.log(`  fast tier (quick classification): ${fast.length ? fast.join(", ") : chalk.yellow("none detected")}`);
  console.log(`  fallback (any installed model): ${fallback.length ? fallback.join(", ") : chalk.red("none — no models installed")}`);
  if (agent.length === 0) {
    console.log(
      chalk.yellow(
        "\nNo installed model matched a known tool-calling-capable family. " +
          "Multi-step OpenSEO skills may be unreliable until one is pulled " +
          "(e.g. `ollama pull qwen2.5-coder:32b`).",
      ),
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const checkOnly = args.includes("--check");
  const outIndex = args.indexOf("--out");
  const outPath = outIndex !== -1 ? args[outIndex + 1] : undefined;

  let models;
  try {
    models = await fetchInstalledModels();
  } catch (error) {
    console.error(chalk.red(`Could not reach Ollama at ${baseUrl}: ${error.message}`));
    console.error("Is the Ollama service running? (`systemctl status ollama` on the VPS)");
    process.exit(1);
  }

  if (checkOnly) {
    console.log(chalk.green(`Ollama reachable at ${baseUrl} (${models.length} model(s) installed).`));
    return;
  }

  const config = buildRoutingConfig(models);

  if (outPath) {
    writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Wrote routing config to ${outPath}`);
  } else if (wantJson) {
    console.log(JSON.stringify(config, null, 2));
  } else {
    printSummary(config);
  }

  if (config.routing.fallback.length === 0) {
    process.exitCode = 1;
  }
}

main();
