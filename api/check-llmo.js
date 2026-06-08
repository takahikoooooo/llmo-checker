/**
 * api/check-llmo.js
 * Vercel Serverless Function — Ahrefs API 中継エンドポイント（v3データ構造完全対応版）
 */

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間キャッシュ

export default async function handler(req, res) {
  // CORS設定
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // APIキー確認
  const apiKey = process.env.AHREFS_API_KEY;
  if (!apiKey) {
    console.error('[check-llmo] AHREFS_API_KEY が設定されていません');
    return res.status(500).json({ error: 'Server configuration error', source: 'internal' });
  }

  // ドメイン取得
  let { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'url パラメータが必要です' });
  }

  const domain = url
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase()
    .trim();

  if (!domain || !/^[a-z0-9][a-z0-9\-\.]+[a-z0-9]$/.test(domain)) {
    return res.status(400).json({ error: '無効なドメイン形式です' });
  }

  // キャッシュチェック
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[check-llmo] キャッシュヒット: ${domain}`);
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    // 1. ドメインレーティング
    const drUrl = new URL('https://api.ahrefs.com/v3/site-explorer/domain-rating');
    drUrl.searchParams.set('select', 'domain_rating,ahrefs_rank');
    drUrl.searchParams.set('target', domain);
    drUrl.searchParams.set('mode', 'domain');

    // 2. バックリンク概要
    const blUrl = new URL('https://api.ahrefs.com/v3/site-explorer/backlinks-stats');
    blUrl.searchParams.set('select', 'live_refdomains,live_backlinks');
    blUrl.searchParams.set('target', domain);
    blUrl.searchParams.set('mode', 'domain');
    blUrl.searchParams.set('protocol', 'both');

    // 3. オーガニックトラフィック概要
    const metricsUrl = new URL('https://api.ahrefs.com/v3/site-explorer/metrics');
    metricsUrl.searchParams.set('select', 'org_traffic,org_keywords');
    metricsUrl.searchParams.set('target', domain);
    metricsUrl.searchParams.set('mode', 'domain');

    const FETCH_OPTS = {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    };

    // 並列リクエスト実行
    const [drRes, blRes, metricsRes] = await Promise.allSettled([
      fetch(drUrl.toString(), FETCH_OPTS),
      fetch(blUrl.toString(), FETCH_OPTS),
      fetch(metricsUrl.toString(), FETCH_OPTS),
    ]);

    async function parseAhrefsResponse(settled, label) {
      if (settled.status === 'rejected') {
        console.warn(`[check-llmo] ${label} リクエスト失敗:`, settled.reason);
        return null;
      }
      const r = settled.value;
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        console.warn(`[check-llmo] ${label} HTTP ${r.status}:`, body.slice(0, 200));
        return null;
      }
      return r.json().catch(() => null);
    }

    const [drData, blData, metricsData] = await Promise.all([
      parseAhrefsResponse(drRes, 'domain-rating'),
      parseAhrefsResponse(blRes, 'backlinks-stats'),
      parseAhrefsResponse(metricsRes, 'metrics'),
    ]);

    // ── 【修正箇所】Ahrefs v3 のネストされたデータ構造から正しく数値を抽出 ──
    const domain_rating     = drData?.domain_rating?.domain_rating ?? drData?.domain_rating ?? null;
    const referring_domains = blData?.metrics?.live_refdomains     ?? blData?.live_refdomains ?? null;
    const backlinks         = blData?.metrics?.live_backlinks      ?? blData?.live_backlinks  ?? null;
    const organic_traffic   = metricsData?.metrics?.org_traffic    ?? metricsData?.org_traffic ?? null;
    const organic_keywords  = metricsData?.metrics?.org_keywords   ?? metricsData?.org_keywords ?? null;

    const responsePayload = {
      domain,
      domain_rating,
      referring_domains,
      backlinks,
      organic_traffic,
      organic_keywords,
      source: 'ahrefs',
      fetched_at: new Date().toISOString(),
    };

    cache.set(domain, { data: responsePayload, timestamp: Date.now() });
    return res.status(200).json(responsePayload);

  } catch (err) {
    console.error('[check-llmo] 予期せぬエラー:', err);
    return res.status(200).json({
      domain,
      domain_rating:     null,
      referring_domains: null,
      backlinks:         null,
      organic_traffic:   null,
      organic_keywords:  null,
      source:            'error_fallback',
      error:             err.message,
    });
  }
}
