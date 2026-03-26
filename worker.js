/**
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  YouTube 아카이브 앱 - Cloudflare Workers
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  배포: https://dash.cloudflare.com → Workers & Pages
 *
 *  [필수 설정]
 *  아래 세 값을 본인 것으로 교체하세요.
 *  (코드 내 직접 입력 또는 Workers 환경 변수 설정)
 *
 *  NOTION_API_KEY : Notion Integration 토큰 (ntn_...)
 *  DATABASE_ID    : Notion DB ID (하이픈 없는 32자)
 *  ALLOWED_ORIGIN : GitHub Pages 주소 (예: https://username.github.io)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

// ──────────────────────────────────────────────────
//  CONFIG  (여기를 수정하세요)
// ──────────────────────────────────────────────────
const NOTION_API_KEY = 'ntn_YOUR_INTEGRATION_TOKEN_HERE';
const DATABASE_ID    = 'YOUR32CHARDBIDWITHOUTDASHES00000';
const ALLOWED_ORIGIN = '*'; // 배포 후 GitHub Pages URL로 변경 권장
const NOTION_VERSION = '2022-06-28';

// ──────────────────────────────────────────────────
//  CORS HEADERS
// ──────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    {
      status,
      headers: {
        'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json',
        ...CORS,
        ...extra,
      },
    }
  );
}

// ──────────────────────────────────────────────────
//  MAIN HANDLER
// ──────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (url.pathname === '/health' && method === 'GET') {
        return corsResponse({ ok: true, service: 'yt-archive-worker', ts: Date.now() });
      }

      if (url.pathname === '/youtubers' && method === 'GET') {
        return await handleGetYoutubers();
      }

      if (url.pathname === '/save' && method === 'POST') {
        const body = await request.json();
        return await handleSave(body);
      }

      return corsResponse('Not Found', 404);

    } catch (err) {
      console.error('[Worker Error]', err);
      return corsResponse(`Internal Server Error: ${err.message}`, 500);
    }
  }
};

// ──────────────────────────────────────────────────
//  GET /youtubers
//  Notion DB의 "작성자/채널" select 옵션 목록 반환
// ──────────────────────────────────────────────────
async function handleGetYoutubers() {
  const res = await notionRequest(
    `GET`,
    `https://api.notion.com/v1/databases/${DATABASE_ID}`
  );

  if (!res.ok) {
    const text = await res.text();
    return corsResponse(`Notion API error: ${text}`, res.status);
  }

  const data = await res.json();

  // "작성자/채널" select 속성에서 옵션 추출
  const prop = data.properties?.['작성자/채널'];
  const options = prop?.select?.options?.map(o => o.name) ?? [];

  return corsResponse({ youtubers: options });
}

// ──────────────────────────────────────────────────
//  POST /save
//  Notion에 새 페이지(영상 카드) 생성
// ──────────────────────────────────────────────────
async function handleSave(body) {
  const { title, url, youtuber, star, categories, memo, thumbnail } = body;

  // 필수값 체크
  if (!title || !url) {
    return corsResponse('title and url are required', 400);
  }

  // ── Notion 페이지 생성 payload ──
  const properties = {
    // 제목 (Title)
    '제목': {
      title: [{ text: { content: title } }]
    },

    // 유튜브 링크
    '유튜브 링크': {
      url: url
    },
  };

  // 작성자/채널 (값이 있을 때만)
  if (youtuber) {
    properties['작성자/채널'] = {
      select: { name: youtuber }
    };
  }

  // 별점 (값이 있을 때만)
  if (star) {
    properties['별점'] = {
      select: { name: star }
    };
  }

  // 카테고리 multi_select
  if (Array.isArray(categories) && categories.length > 0) {
    properties['카테고리'] = {
      multi_select: categories.map(c => ({ name: c }))
    };
  }

  // 한줄평
  if (memo) {
    properties['한줄평'] = {
      rich_text: [{ text: { content: memo } }]
    };
  }

  // ── 페이지 생성 body ──
  const pageBody = {
    parent:     { database_id: DATABASE_ID },
    properties,
    // 커버 이미지: YouTube 썸네일 자동 적용
    ...(thumbnail ? { cover: { type: 'external', external: { url: thumbnail } } } : {}),
  };

  const res = await notionRequest(
    'POST',
    'https://api.notion.com/v1/pages',
    pageBody
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('[Notion Save Error]', text);
    return corsResponse(`Notion API error: ${text}`, res.status);
  }

  const page = await res.json();
  return corsResponse({
    ok:      true,
    page_id: page.id,
    url:     page.url,
  });
}

// ──────────────────────────────────────────────────
//  NOTION API 헬퍼
// ──────────────────────────────────────────────────
function notionRequest(method, url, body = null) {
  const init = {
    method,
    headers: {
      'Authorization':  `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type':   'application/json',
    },
  };
  if (body) init.body = JSON.stringify(body);
  return fetch(url, init);
}
