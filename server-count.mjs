#!/usr/bin/env node
/**
 * server-count.mjs — count how many servers each RECONSUMET-TS provider
 * actually returns (sub + dub, differentiated and combined), across a
 * fixed list of test anime, printed as a tree + summary.
 *
 * Usage: node server-count.mjs
 * (no deps beyond Node's built-in fetch, Node 18+)
 */

const BASE = "https://api.thesupersuperanime.lol";

// Fill in / adjust these — the script prints each resolved title so you can
// visually confirm an id actually points at the anime you meant.
const ANIME_IDS = [
  112641, // love is war?
  169580, // I Made Friends With The Second Prettiest Girl In My Class
  21,     // One Piece
  20,     // Naruto 
  269,    // Bleach 
];

async function getJSON(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: null, raw: text };
  }
}

async function main() {
  console.log(`RECONSUMET-TS server-count — ${BASE}\n`);

  const grandTotals = {}; // provider -> { sub: n, dub: n }

  for (const anilistId of ANIME_IDS) {
    console.log("=".repeat(70));
    const info = await getJSON(`${BASE}/info/${anilistId}`);
    if (!info.ok || !info.data) {
      console.log(`anilistId ${anilistId}: FAILED to resolve (${info.status})`);
      continue;
    }
    const mappings = info.data.mappings || [];
    const guessTitle = mappings[0]?.title || "(unknown — check mappings manually)";
    console.log(`anilistId ${anilistId} — resolved title guess: "${guessTitle}"`);
    console.log(`  -> CONFIRM this is the anime you meant before trusting counts below.`);
    console.log("=".repeat(70));

    if (mappings.length === 0) {
      console.log("  (no providers have this title)\n");
      continue;
    }

    for (const mapping of mappings) {
      const provider = mapping.provider;
      const episodes = await getJSON(
        `${BASE}/episodes/${anilistId}?provider=${encodeURIComponent(provider)}`
      );
      const ep1 = episodes.data?.episodes?.[0];
      if (!ep1) {
        console.log(`  ${provider}`);
        console.log(`    (no episode 1 found — skipping)`);
        continue;
      }

      const watch = await getJSON(
        `${BASE}/watch?provider=${encodeURIComponent(provider)}&episodeId=${encodeURIComponent(
          ep1.id
        )}&type=sub`
      );
      const watchDub = await getJSON(
        `${BASE}/watch?provider=${encodeURIComponent(provider)}&episodeId=${encodeURIComponent(
          ep1.id
        )}&type=dub`
      );

      const subServers = watch.data?.sub || [];
      const dubServers = watchDub.data?.dub || watch.data?.dub || [];

      const subCount = Array.isArray(subServers) ? subServers.length : subServers ? 1 : 0;
      const dubCount = Array.isArray(dubServers) ? dubServers.length : dubServers ? 1 : 0;
      const combined = subCount + dubCount;

      console.log(`  ${provider}`);
      console.log(`    sub: ${subCount}`);
      if (Array.isArray(subServers)) {
        subServers.forEach((s, i) =>
          console.log(`      ${i === subServers.length - 1 ? "└─" : "├─"} ${s.serverName || s.server || `server ${i + 1}`}`)
        );
      }
      console.log(`    dub: ${dubCount}`);
      if (Array.isArray(dubServers)) {
        dubServers.forEach((s, i) =>
          console.log(`      ${i === dubServers.length - 1 ? "└─" : "├─"} ${s.serverName || s.server || `server ${i + 1}`}`)
        );
      }
      console.log(`    combined (sub+dub): ${combined}`);

      grandTotals[provider] = grandTotals[provider] || { sub: 0, dub: 0 };
      grandTotals[provider].sub += subCount;
      grandTotals[provider].dub += dubCount;
    }
    console.log("");
  }

  console.log("=".repeat(70));
  console.log("SUMMARY — total servers per provider, across all tested anime");
  console.log("=".repeat(70));
  console.log("(differentiated)");
  let totalSub = 0,
    totalDub = 0;
  for (const [provider, counts] of Object.entries(grandTotals)) {
    console.log(`  ${provider}: sub=${counts.sub}, dub=${counts.dub}`);
    totalSub += counts.sub;
    totalDub += counts.dub;
  }
  console.log("");
  console.log("(combined)");
  for (const [provider, counts] of Object.entries(grandTotals)) {
    console.log(`  ${provider}: ${counts.sub + counts.dub}`);
  }
  console.log("");
  console.log(`GRAND TOTAL — sub: ${totalSub}, dub: ${totalDub}, combined: ${totalSub + totalDub}`);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
