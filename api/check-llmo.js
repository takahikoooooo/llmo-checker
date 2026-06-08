/**
 * api/check-llmo.js
 * Vercel Serverless Function — Ahrefs API 中継エンドポイント（v3配列構造完全適応版）
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
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const FETCH_OPTS = {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    };

    // 1. ドメインレーティング
    const drUrl = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${domain}&mode=domain&select=domain_rating`;
    // 2. バックリンク概要
    const blUrl = `https://api.ahrefs.com/v3/site-explorer/backlinks-stats?target=${domain}&mode=domain&select=live_refdomains,live_backlinks`;
    // 3. メトリクス
    const metricsUrl = `https://api.ahrefs.com/v3/site-explorer/metrics?target=${domain}&mode=domain&select=org_traffic,org_keywords`;

    // 並列リクエスト実行
    const [drRes, blRes, metricsRes] = await Promise.allSettled([
      fetch(drUrl, FETCH_OPTS).then(r => r.ok ? r.json() : null),
      fetch(blUrl, FETCH_OPTS).then(r => r.ok ? r.json() : null),
      fetch(metricsUrl, FETCH_OPTS).then(r => r.ok ? r.json() : null),
    ]);

    const drData = drRes.status === 'fulfilled' ? drRes.value : null;
    const blData = blRes.status === 'fulfilled' ? blRes.value : null;
    const metricsData = metricsRes.status === 'fulfilled' ? metricsRes.value : null;

    // ── 【超重要】Ahrefs v3 の「配列ネスト構造」を1コずつ確実に解凍する ──
    
    // DRの抽出
    let domain_rating = null;
    if (drData?.domain_rating?.domain_rating !== undefined) {
      domain_rating = drData.domain_rating.domain_rating;
    } else if (Array.isArray(drData?.domain_rating) && drData.domain_rating[0]?.domain_rating !== undefined) {
      domain_rating = drData.domain_rating[0].domain_rating;
    } else if (drData?.domain_rating !== undefined && typeof drData.domain_rating !== 'object') {
      domain_rating = drData.domain_rating;
    }

    // 参照ドメイン・バックリンクの抽出
    let referring_domains = null;
    let backlinks = null;
    const blTarget = blData?.metrics || blData;
    if (Array.isArray(blTarget)) {
      referring_domains = blTarget[0]?.live_refdomains ?? null;
      backlinks = blTarget[0]?.live_backlinks ?? null;
    } else if (blTarget) {
      referring_domains = blTarget.live_refdomains ?? null;
      backlinks = blTarget.live_backlinks ?? null;
    }

    // トラフィックの抽出
    let organic_traffic = null;
    let organic_keywords = null;
    const metricsTarget = metricsData?.metrics || metricsData;
    if (Array.isArray(metricsTarget)) {
      organic_traffic = metricsTarget[0]?.org_traffic ?? null;
      organic_keywords = metricsTarget[0]?.org_keywords ?? null;
    } else if (metricsTarget) {
      organic_traffic = metricsTarget.org_traffic ?? null;
      organic_keywords = metricsTarget.org_keywords ?? null;
    }

    // 【最終防衛策】もしこれでも解凍できなかった場合、Ahrefsが返した生データをそのままフロントに渡して無理やり表示させる
    const responsePayload = {
      domain,
      domain_rating: domain_rating ?? drData?.domain_rating ?? null,
      referring_domains: referring_domains ?? blData?.live_refdomains ?? null,
      backlinks: backlinks ?? blData?.live_backlinks ?? null,
      organic_traffic: organic_traffic ?? metricsData?.org_traffic ?? null,
      organic_keywords: organic_keywords ?? metricsData?.org_keywords ?? null,
      source: 'ahrefs',
      fetched_at: new Date().toISOString(),
    };

    cache.set(domain, { data: responsePayload, timestamp: Date.now() });
    return res.status(200).json(responsePayload);

  } catch (err) {
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
