const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CACHE_PATH = path.resolve(__dirname, '../game_cache.json');

if (!WEBHOOK_URL) {
  console.error('DISCORD_WEBHOOK_URL not set!');
  process.exit(1);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetch(url, wantJson = true, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          Accept: wantJson
            ? 'application/json'
            : 'text/html,application/xhtml+xml,*/*',
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
          return resolve(fetch(next, wantJson, redirects - 1));
        }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            if (wantJson) {
              try { resolve(JSON.parse(data)); }
              catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
            } else {
              resolve(data);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout')));
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
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`HTTP ${res.statusCode}: ${d}`));
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch { return { epic: [], steam: [] }; }
}

function saveCache(c) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2));
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

// ─── Epic Games – free games ──────────────────────────────────────────────────

async function getEpicFreeGames() {
  const data = await fetch(
    'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US'
  );
  const elements = data?.data?.Catalog?.searchStore?.elements || [];
  const now = new Date();
  return elements
    .filter((g) => {
      const offers = g.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
      return offers.some((o) => {
        const s = new Date(o.startDate), e = new Date(o.endDate);
        return now >= s && now <= e &&
          (o.discountSetting?.discountPercentage === 0 ||
           o.discountSetting?.discountType === 'PERCENTAGE');
      });
    })
    .map((g) => {
      const offer = g.promotions.promotionalOffers[0].promotionalOffers[0];
      const slug = g.productSlug || g.catalogNs?.mappings?.[0]?.pageSlug || '';
      const image = g.keyImages?.find(
        (i) => i.type === 'Thumbnail' || i.type === 'DieselGameBox'
      )?.url || '';
      return {
        id: g.id,
        title: g.title,
        description: (g.description || '').slice(0, 180),
        image,
        url: slug
          ? `https://store.epicgames.com/en-US/p/${slug}`
          : 'https://store.epicgames.com/en-US/free-games',
        endDate: offer.endDate,
      };
    });
}

// ─── Steam – 100% off (free to keep) ─────────────────────────────────────────

async function getSteamFreeGames() {
  const data = await fetch(
    'https://store.steampowered.com/api/featuredcategories/?cc=US&l=en'
  );
  return (data?.specials?.items || [])
    .filter((g) => g.discount_percent === 100 && g.original_price > 0 && g.final_price === 0)
    .map((g) => ({
      id: `steam-free-${g.id}`,
      title: g.name,
      image: g.large_capsule_image || g.header_image || '',
      url: `https://store.steampowered.com/app/${g.id}`,
    }));
}

// ─── Steam Focus – daily top deals (CheapShark) ───────────────────────────────

async function getTopSteamDeals() {
  const data = await fetch(
    'https://www.cheapshark.com/api/1.0/deals?storeID=1&sortBy=Deal+Rating&pageSize=5&onSale=1'
  );
  return (data || []).slice(0, 5).map((d) => ({
    title: d.title,
    salePrice: `$${parseFloat(d.salePrice).toFixed(2)}`,
    normalPrice: `$${parseFloat(d.normalPrice).toFixed(2)}`,
    savings: Math.round(parseFloat(d.savings)),
    rating: parseFloat(d.dealRating).toFixed(1),
    thumb: d.thumb,
    url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
  }));
}

// ─── Grape Gaming – key deals (grpg.co) ──────────────────────────────────────

async function getGrapeGamingDeals() {
  try {
    const html = await fetch('https://www.grpg.co', false);

    // Next.js sites embed all page data in __NEXT_DATA__
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
    if (m) {
      const nd = JSON.parse(m[1]);
      const props = nd?.props?.pageProps;
      const raw =
        props?.products ||
        props?.deals ||
        props?.items ||
        props?.featuredDeals ||
        props?.data?.products ||
        props?.data?.deals ||
        [];
      if (raw.length > 0) {
        return raw.slice(0, 5).map((p) => {
          const price = p.price ?? p.salePrice ?? p.discountedPrice;
          const orig = p.originalPrice ?? p.regularPrice ?? p.msrp;
          const discount =
            p.discount ?? p.discountPercent ??
            (price != null && orig != null && orig > 0
              ? Math.round((1 - price / orig) * 100)
              : null);
          return {
            title: p.name || p.title || 'Game Key Deal',
            price: price != null ? `$${parseFloat(price).toFixed(2)}` : 'N/A',
            originalPrice: orig != null ? `$${parseFloat(orig).toFixed(2)}` : null,
            discount,
            url: p.slug
              ? `https://www.grpg.co/product/${p.slug}`
              : p.url || 'https://www.grpg.co',
          };
        });
      }
    }

    // Fallback: try their possible deals API endpoints
    for (const endpoint of ['/api/deals', '/api/products?limit=5&sort=discount']) {
      try {
        const json = await fetch(`https://www.grpg.co${endpoint}`);
        const items = Array.isArray(json) ? json : json?.data || json?.products || json?.deals || [];
        if (items.length > 0) {
          return items.slice(0, 5).map((p) => ({
            title: p.name || p.title || 'Game Key Deal',
            price: p.price != null ? `$${parseFloat(p.price).toFixed(2)}` : 'N/A',
            discount: p.discount || p.discountPercent || null,
            url: p.slug ? `https://www.grpg.co/product/${p.slug}` : 'https://www.grpg.co',
          }));
        }
      } catch { /* try next */ }
    }
  } catch (e) {
    console.error('Grape Gaming fetch failed:', e.message);
  }
  return [];
}

// ─── Build Discord embeds ─────────────────────────────────────────────────────

function buildEpicEmbed(game) {
  return {
    title: `🎁 FREE on Epic: ${game.title}`,
    description: game.description || 'Free to claim on Epic Games Store!',
    url: game.url,
    color: 0x2b2d31,
    thumbnail: game.image ? { url: game.image } : undefined,
    fields: [
      {
        name: '⏰ Free Until',
        value: game.endDate ? fmtDate(game.endDate) : 'Limited time',
        inline: true,
      },
      {
        name: '🔗 Claim',
        value: '[Open Epic Games Store](https://store.epicgames.com/en-US/free-games)',
        inline: true,
      },
    ],
    footer: { text: 'Epic Games Store • Free Games' },
    timestamp: new Date().toISOString(),
  };
}

function buildSteamFreeEmbed(game) {
  return {
    title: `🎁 FREE on Steam: ${game.title}`,
    description: 'Temporarily free on Steam — add it to your library before it ends!',
    url: game.url,
    color: 0x1b2838,
    thumbnail: game.image ? { url: game.image } : undefined,
    fields: [
      { name: '🔗 Claim', value: `[Open Steam Page](${game.url})`, inline: true },
    ],
    footer: { text: 'Steam • Free Games' },
    timestamp: new Date().toISOString(),
  };
}

function buildSteamDealsEmbed(deals) {
  if (deals.length === 0) return null;
  return {
    title: '🔥 Daily Steam Deals — Top Picks',
    color: 0x1b2838,
    fields: deals.map((d) => ({
      name: d.title,
      value: `~~${d.normalPrice}~~ → **${d.salePrice}** (${d.savings}% off) • ⭐ ${d.rating}\n[View Deal](${d.url})`,
      inline: false,
    })),
    footer: { text: 'Steam via CheapShark • Daily Deals' },
    timestamp: new Date().toISOString(),
  };
}

function buildGrapeEmbed(deals) {
  if (deals.length === 0) return null;
  return {
    title: '🍇 Grape Gaming — Key Deals',
    url: 'https://www.grpg.co',
    color: 0x6b2d8b,
    fields: deals.map((d) => ({
      name: d.title,
      value: [
        d.originalPrice ? `~~${d.originalPrice}~~ → ` : '',
        `**${d.price}**`,
        d.discount ? ` (${d.discount}% off)` : '',
        `\n[Get Key](${d.url})`,
      ].join(''),
      inline: false,
    })),
    footer: { text: 'Grape Gaming • grpg.co' },
    timestamp: new Date().toISOString(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cache = loadCache();
  const embeds = [];

  // --- Epic free games (only notify if new) ---
  let epicGames = [];
  try {
    epicGames = await getEpicFreeGames();
    console.log(`Epic: ${epicGames.length} free game(s) found`);
  } catch (e) {
    console.error('Epic fetch failed:', e.message);
  }
  const newEpic = epicGames.filter((g) => !cache.epic.includes(g.id));
  for (const g of newEpic) embeds.push(buildEpicEmbed(g));

  // --- Steam free games (only notify if new) ---
  let steamFree = [];
  try {
    steamFree = await getSteamFreeGames();
    console.log(`Steam free: ${steamFree.length} game(s) found`);
  } catch (e) {
    console.error('Steam free fetch failed:', e.message);
  }
  const newSteamFree = steamFree.filter((g) => !cache.steam.includes(g.id));
  for (const g of newSteamFree) embeds.push(buildSteamFreeEmbed(g));

  // --- Daily Steam deals (always post) ---
  let steamDeals = [];
  try {
    steamDeals = await getTopSteamDeals();
    console.log(`Steam deals: ${steamDeals.length} deal(s) found`);
  } catch (e) {
    console.error('Steam deals fetch failed:', e.message);
  }
  const dealsEmbed = buildSteamDealsEmbed(steamDeals);
  if (dealsEmbed) embeds.push(dealsEmbed);

  // --- Grape Gaming deals (always post) ---
  let grapeDeals = [];
  try {
    grapeDeals = await getGrapeGamingDeals();
    console.log(`Grape Gaming: ${grapeDeals.length} deal(s) found`);
  } catch (e) {
    console.error('Grape Gaming fetch failed:', e.message);
  }
  const grapeEmbed = buildGrapeEmbed(grapeDeals);
  if (grapeEmbed) embeds.push(grapeEmbed);

  if (embeds.length === 0) {
    console.log('Nothing new to post today.');
    return;
  }

  // Discord max 10 embeds per message
  for (let i = 0; i < embeds.length; i += 10) {
    await sendWebhook({ embeds: embeds.slice(i, i + 10) });
  }

  console.log(`Posted ${embeds.length} embed(s) to Discord.`);

  // Update cache for free game deduplication
  cache.epic = epicGames.map((g) => g.id);
  cache.steam = steamFree.map((g) => g.id);
  saveCache(cache);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
