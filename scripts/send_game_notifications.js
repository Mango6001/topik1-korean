const https = require('https');
const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CACHE_PATH = path.resolve(__dirname, '../game_cache.json');

if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL not set!');
  process.exit(1);
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GameNotifyBot/1.0)',
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`JSON parse error: ${e.message}`));
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });
  });
}

async function getEpicFreeGames() {
  const url =
    'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
  const data = await httpsGet(url);
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = new Date();

  return elements
    .filter((game) => {
      const currentOffers =
        game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
      return currentOffers.some((offer) => {
        const start = new Date(offer.startDate);
        const end = new Date(offer.endDate);
        const isFree =
          offer.discountSetting?.discountPercentage === 0 ||
          offer.discountSetting?.discountType === 'PERCENTAGE';
        return now >= start && now <= end && isFree;
      });
    })
    .map((game) => {
      const offer =
        game.promotions.promotionalOffers[0].promotionalOffers[0];
      const slug =
        game.productSlug ||
        game.catalogNs?.mappings?.[0]?.pageSlug ||
        '';
      const thumbnail =
        game.keyImages?.find(
          (img) => img.type === 'Thumbnail' || img.type === 'DieselGameBox'
        )?.url || '';

      return {
        id: game.id,
        title: game.title,
        description: (game.description || '').slice(0, 200),
        image: thumbnail,
        url: slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games',
        endDate: offer.endDate,
      };
    });
}

async function getSteamFreeGames() {
  const url =
    'https://store.steampowered.com/api/featuredcategories/?cc=US&l=en';
  const data = await httpsGet(url);
  const specials = data?.specials?.items || [];

  return specials
    .filter(
      (game) =>
        game.discount_percent === 100 &&
        game.original_price > 0 &&
        game.final_price === 0
    )
    .map((game) => ({
      id: `steam-${game.id}`,
      title: game.name,
      image: game.large_capsule_image || game.header_image || '',
      url: `https://store.steampowered.com/app/${game.id}`,
    }));
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return { epic: [], steam: [] };
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

function formatEndDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function sendWebhook(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(WEBHOOK_URL);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const cache = loadCache();
  const embeds = [];

  // --- Epic Games ---
  let epicGames = [];
  try {
    epicGames = await getEpicFreeGames();
    console.log(`Epic: found ${epicGames.length} free game(s)`);
  } catch (err) {
    console.error('Failed to fetch Epic games:', err.message);
  }

  const newEpic = epicGames.filter((g) => !cache.epic.includes(g.id));

  for (const game of newEpic) {
    embeds.push({
      title: `🎮 Free on Epic: ${game.title}`,
      description: game.description || 'Free to claim on the Epic Games Store!',
      url: game.url,
      color: 0x2b2d31,
      thumbnail: game.image ? { url: game.image } : undefined,
      fields: [
        {
          name: 'Free Until',
          value: game.endDate ? formatEndDate(game.endDate) : 'Limited time',
          inline: true,
        },
        {
          name: 'Store',
          value: '[Claim on Epic Games](https://store.epicgames.com/en-US/free-games)',
          inline: true,
        },
      ],
      footer: { text: 'Epic Games Store • Free Games' },
      timestamp: new Date().toISOString(),
    });
  }

  // --- Steam ---
  let steamGames = [];
  try {
    steamGames = await getSteamFreeGames();
    console.log(`Steam: found ${steamGames.length} free game(s)`);
  } catch (err) {
    console.error('Failed to fetch Steam games:', err.message);
  }

  const newSteam = steamGames.filter((g) => !cache.steam.includes(g.id));

  for (const game of newSteam) {
    embeds.push({
      title: `🎮 Free on Steam: ${game.title}`,
      description: 'Currently free on Steam — grab it before the offer ends!',
      url: game.url,
      color: 0x1b2838,
      thumbnail: game.image ? { url: game.image } : undefined,
      fields: [
        {
          name: 'Store',
          value: `[View on Steam](${game.url})`,
          inline: true,
        },
      ],
      footer: { text: 'Steam Store • Free Games' },
      timestamp: new Date().toISOString(),
    });
  }

  if (embeds.length === 0) {
    console.log('No new free games to notify about.');
    return;
  }

  // Discord allows max 10 embeds per message; chunk if needed
  for (let i = 0; i < embeds.length; i += 10) {
    await sendWebhook({ embeds: embeds.slice(i, i + 10) });
  }

  console.log(`Sent ${embeds.length} embed(s) to Discord.`);

  // Update cache
  cache.epic = epicGames.map((g) => g.id);
  cache.steam = steamGames.map((g) => g.id);
  saveCache(cache);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
