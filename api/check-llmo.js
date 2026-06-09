/**
 * api/check-llmo.js — Vercel Serverless Function
 * Ahrefs API v3 中継エンドポイント（デバッグ強化・URL修正版）
 *
 * 環境変数（Vercel → Settings → Environment Variables）:
 *   AHREFS_API_KEY  ... AhrefsのAPIキー
 *   ALLOWED_ORIGIN  ... CORSを許可するオリジン（省略時は * ）
 */

const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間キャッシュ

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const apiKey = process.env.AHREFS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'AHREFS_API_KEY が設定されていません', source: 'internal' });
  }

  // ── ドメイン取得・検証 ─────────────────────────
  let { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url パラメータが必要です' });

  const domain = url
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase()
    .trim();

  if (!domain || !/^[a-z0-9][a-z0-9\-\.]+[a-z0-9]$/.test(domain)) {
    return res.status(400).json({ error: '無効なドメイン形式です' });
  }

  // ── キャッシュチェック ─────────────────────────
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  // ── Ahrefs API 呼び出し ─────────────────────────
  const OPTS = {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  };

  // 【重要】公式ドキュメントに従い:
  //   domain-rating  → select不要、mode=domainのみ
  //   backlinks-stats → select指定あり
  //   metrics        → select指定あり、country=jpで日本データ
  // 今日の日付を YYYY-MM-DD 形式で取得
  const today = new Date().toISOString().slice(0, 10);

  const drUrl      = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(domain)}&mode=domain&date=${today}`;
  const blUrl      = `https://api.ahrefs.com/v3/site-explorer/backlinks-stats?target=${encodeURIComponent(domain)}&mode=domain&date=${today}`;
  const metricsUrl = `https://api.ahrefs.com/v3/site-explorer/metrics?target=${encodeURIComponent(domain)}&mode=domain&country=jp&date=${today}`;

  // 各リクエストの生レスポンスを保存（デバッグ用）
  const debugInfo = { drUrl, blUrl, metricsUrl };

  try {
    // ── DR取得 ──────────────────────────────────
    const drRaw = await fetch(drUrl, OPTS);
    const drStatus = drRaw.status;
    const drBody = await drRaw.text();
    debugInfo.dr_status = drStatus;
    debugInfo.dr_body_preview = drBody.slice(0, 300);

    let drData = null;
    try { drData = JSON.parse(drBody); } catch(_) {}

    // DR値の抽出（v3レスポンス構造に対応）
    let domain_rating = null;
    if (drData) {
      // パターン1: { "domain_rating": 42 }
      if (typeof drData.domain_rating === 'number') {
        domain_rating = drData.domain_rating;
      }
      // パターン2: { "domain_rating": { "domain_rating": 42 } }
      else if (typeof drData.domain_rating === 'object' && drData.domain_rating !== null) {
        domain_rating = drData.domain_rating.domain_rating ?? null;
      }
    }

    // ── BL取得 ──────────────────────────────────
    const blRaw = await fetch(blUrl, OPTS);
    const blStatus = blRaw.status;
    const blBody = await blRaw.text();
    debugInfo.bl_status = blStatus;
    debugInfo.bl_body_preview = blBody.slice(0, 300);

    let blData = null;
    try { blData = JSON.parse(blBody); } catch(_) {}

    let referring_domains = null;
    let backlinks = null;
    if (blData) {
      // パターン1: { "live_refdomains": 102, "live_backlinks": 500 }
      if (typeof blData.live_refdomains === 'number') {
        referring_domains = blData.live_refdomains;
        backlinks = blData.live_backlinks ?? null;
      }
      // パターン2: { "metrics": { "live_refdomains": 102 } }
      else if (blData.metrics) {
        referring_domains = blData.metrics.live_refdomains ?? null;
        backlinks = blData.metrics.live_backlinks ?? null;
      }
    }

    // ── Metrics取得 ─────────────────────────────
    const metricsRaw = await fetch(metricsUrl, OPTS);
    const metricsStatus = metricsRaw.status;
    const metricsBody = await metricsRaw.text();
    debugInfo.metrics_status = metricsStatus;
    debugInfo.metrics_body_preview = metricsBody.slice(0, 300);

    let metricsData = null;
    try { metricsData = JSON.parse(metricsBody); } catch(_) {}

    let organic_traffic = null;
    let organic_keywords = null;
    if (metricsData) {
      // パターン1: { "org_traffic": 5200 }
      if (typeof metricsData.org_traffic === 'number') {
        organic_traffic = metricsData.org_traffic;
        organic_keywords = metricsData.org_keywords ?? null;
      }
      // パターン2: { "metrics": { "org_traffic": 5200 } }
      else if (metricsData.metrics) {
        organic_traffic = metricsData.metrics.org_traffic ?? null;
        organic_keywords = metricsData.metrics.org_keywords ?? null;
      }
    }

    const responsePayload = {
      domain,
      domain_rating,
      referring_domains,
      backlinks,
      organic_traffic,
      organic_keywords,
      source: 'ahrefs',
      fetched_at: new Date().toISOString(),
      // デバッグ情報（本番では削除可能）
      _debug: debugInfo,
    };

    // 成功時のみキャッシュ（DR取得できた場合）
    if (domain_rating !== null) {
      cache.set(domain, { data: responsePayload, timestamp: Date.now() });
    }

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
