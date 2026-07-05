import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { seedDeck } from "../main/services/populate";
import { SEED_SENTENCES } from "../main/services/seedSentences";
import { initCostStore } from "../main/services/costs";

dotenv.config();

// Track API spend in the same file the Electron app uses (its userData dir),
// so CLI seed runs are counted too.
initCostStore(
  path.join(os.homedir(), "Library", "Application Support", "bgurbot", "costs.json"),
);

const args = process.argv.slice(2);
const argMap = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), args[++i]];
    argMap.set(k, v);
  }
}

const targetDeck = argMap.get("deck") ?? "bgbot";
const newPerDay = Number(argMap.get("new") ?? 200);
const revPerDay = Number(argMap.get("rev") ?? 9999);

console.log(`bgurbot seed: ${SEED_SENTENCES.length} starter sentences → "${targetDeck}"`);

seedDeck(SEED_SENTENCES, {
  bgbotDeckName: targetDeck,
  newPerDay,
  revPerDay,
})
  .then(({ added, skipped }) => {
    console.log(`SUCCESS: added=${added} skipped=${skipped}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
