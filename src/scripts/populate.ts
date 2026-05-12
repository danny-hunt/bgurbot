import dotenv from "dotenv";
import { populate } from "../main/services/populate";

dotenv.config();

const args = process.argv.slice(2);
const argMap = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith("--")) {
    const [k, v] = a.includes("=") ? a.slice(2).split("=") : [a.slice(2), args[++i]];
    argMap.set(k, v);
  }
}

const total = Number(argMap.get("total") ?? 200);
const batch = Number(argMap.get("batch") ?? 10);
const sourceDeck = argMap.get("source") ?? "Ling::Urdu";
const targetDeck = argMap.get("deck") ?? "bgbot";
const newPerDay = Number(argMap.get("new") ?? 200);
const revPerDay = Number(argMap.get("rev") ?? 9999);

console.log(`bgurbot populate: ${total} sentences in batches of ${batch}`);
console.log(`  source: "${sourceDeck}" → target: "${targetDeck}"`);
console.log(`  deck options: new/day=${newPerDay}, rev/day=${revPerDay}`);

populate({
  vocabSourceDeck: sourceDeck,
  bgbotDeckName: targetDeck,
  totalSentences: total,
  batchSize: batch,
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
