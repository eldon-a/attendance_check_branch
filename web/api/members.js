/**
 * Vercel Serverless Function: 회원 목록 프록시
 *
 * Apps Script 의 getMembers 응답을 Vercel Edge 캐시로 분배한다.
 * - 시트 → Apps Script → 이 함수 → CDN 캐시 (5분 fresh + 10분 stale-while-revalidate)
 * - 캐시 만료 후 다음 요청 1건만 GAS 를 호출 → 동시 접속 부하가 GAS 에 가지 않음
 * - 시트 편집은 최대 ~10분 안에 자동 반영됨
 *
 * 환경변수:
 *   GAS_URL = https://script.google.com/macros/s/.../exec
 *
 * 즉시 갱신이 필요하면 ?refresh=1 쿼리스트링으로 캐시 우회.
 */

export default async function handler(req, res) {
  const GAS_URL = process.env.GAS_URL;
  if (!GAS_URL) {
    return res
      .status(500)
      .json({ ok: false, message: '서버 설정 오류: GAS_URL 환경변수 미설정' });
  }

  const refresh = req.query && req.query.refresh === '1';

  try {
    // Apps Script 는 POST + JSON body 의 action 을 받는 구조
    const upstream = await fetch(GAS_URL, {
      method: 'POST',
      // CORS preflight 회피용 — 서버 간 통신이라 사실 무관하지만 기존 클라이언트 호환
      body: JSON.stringify({ action: 'getMembers' }),
      // GAS 는 redirect 를 자주 응답함 (Google 도메인 간)
      redirect: 'follow',
    });

    if (!upstream.ok) {
      return res
        .status(502)
        .json({ ok: false, message: `GAS HTTP ${upstream.status}` });
    }

    const text = await upstream.text();

    // JSON 응답인지 확인 (Apps Script 가 가끔 HTML 오류 페이지를 반환)
    try {
      const parsed = JSON.parse(text);
      if (!parsed.ok) {
        // GAS 측 에러는 캐시하지 않음 (no-store)
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json(parsed);
      }
    } catch (parseErr) {
      res.setHeader('Cache-Control', 'no-store');
      return res
        .status(502)
        .json({ ok: false, message: 'GAS 응답이 JSON 이 아님 (인증/배포 확인 필요)' });
    }

    // 캐시 정책
    if (refresh) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // s-maxage: CDN 캐시 (5분), stale-while-revalidate: 만료 후에도 10분간 옛 응답 제공
      // → 사실상 GAS 호출은 시간당 ~12회로 고정
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(text);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    return res
      .status(502)
      .json({ ok: false, message: 'GAS 호출 실패: ' + (err && err.message ? err.message : String(err)) });
  }
}
