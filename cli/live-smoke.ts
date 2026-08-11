import { main } from "./index.js";

if (process.env.ALPHION_LIVE_SMOKE !== "1") {
  process.stderr.write("Live smoke is disabled. Set ALPHION_LIVE_SMOKE=1 explicitly to allow a real provider request.\n");
  process.exitCode = 2;
} else {
  const prompt = process.env.ALPHION_LIVE_SMOKE_PROMPT ?? "Reply with the single word: ready";
  process.exitCode = await main(["run", "--prompt", prompt, ...process.argv.slice(2)]);
}
