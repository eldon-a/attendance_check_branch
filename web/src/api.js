/**
 * Apps Script API 클라이언트
 *
 * CORS preflight 를 피하기 위해 Content-Type 을 text/plain 으로 보낸다.
 * Apps Script 는 simple request (GET, POST + text/plain) 에 대해 자동으로 CORS 헤더를 붙인다.
 */

const API_URL = (import.meta.env.VITE_API_URL || '').trim();

if (!API_URL) {
  // 개발자 콘솔에서 즉시 원인 파악할 수 있게 경고
  console.error('[api] VITE_API_URL 이 설정되지 않았습니다. web/.env.local 을 확인하고 vite dev 서버를 재시작하세요.');
} else if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(API_URL)) {
  console.warn('[api] VITE_API_URL 형식이 의심스럽습니다. 보통 https://script.google.com/macros/s/.../exec 형태여야 합니다. 현재 값:', API_URL);
}

// 네트워크 수준 실패(재시도 가능) 를 식별하기 위한 마커 클래스
class NetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
    this.isNetworkError = true;
  }
}

/**
 * Apps Script 호출.
 * @param {string} action
 * @param {object} params
 * @param {object} [opts] - { timeoutMs?: number }
 *   네트워크 실패는 NetworkError 로 throw 해서 호출부가 재시도/큐잉 가능하게 구분.
 */
async function call(action, params = {}, opts = {}) {
  if (!API_URL) {
    throw new Error('API URL 이 설정되지 않았습니다. .env.local 의 VITE_API_URL 을 확인하세요.');
  }

  const timeoutMs = opts.timeoutMs || 12000;
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  // Content-Type 을 생략하여 브라우저가 자동으로 text/plain 으로 처리 → preflight 회피
  // (일부 브라우저는 "text/plain;charset=utf-8" 에서도 preflight 를 내보냅니다)
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      mode: 'cors',
      signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ action, ...params })
    });
  } catch (networkErr) {
    console.error('[api] fetch 실패:', networkErr, 'URL:', API_URL);
    throw new NetworkError(
      networkErr && networkErr.name === 'AbortError'
        ? '네트워크 응답 지연 (시간 초과)'
        : '네트워크 오류 (오프라인 또는 서버 응답 없음)',
      networkErr
    );
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    // 5xx 는 일시 오류로 간주 → NetworkError 로 throw
    if (res.status >= 500) {
      throw new NetworkError(`서버 일시 오류 HTTP ${res.status}`);
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (e) {
    throw new NetworkError('응답 본문 읽기 실패');
  }
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    console.error('[api] JSON 파싱 실패. 원문 응답:', text.slice(0, 500));
    throw new Error(
      'API 응답이 JSON 이 아닙니다. Apps Script 가 HTML 오류 페이지를 반환했을 가능성이 높습니다. ' +
      '브라우저에서 VITE_API_URL 을 직접 열어 확인하세요.'
    );
  }
}

// ----- 회원 캐시 (localStorage) -----
const MEMBERS_CACHE_KEY = 'attn.members.v1';
// 동시 접속 부하를 줄이기 위해 단말 캐시 TTL 을 1시간으로 연장.
// Vercel Edge 캐시(5분 fresh + 10분 SWR) 와 합쳐 시트 편집은 최대 ~75분 안에 반영.
const MEMBERS_TTL_MS = 60 * 60 * 1000; // 1시간

/**
 * 회원 목록 조회.
 *
 * 우선 Vercel 프록시(/api/members) 를 호출한다 — Edge CDN 가 캐시하므로
 * 동시 접속이 많아도 GAS 에 부하가 가지 않는다. 응답이 없으면(개발 환경 등)
 * GAS 직접 호출로 폴백한다.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]   localStorage 캐시 무시
 * @param {boolean} [opts.refresh] 프록시의 CDN 캐시까지 우회 (관리자용)
 */
export async function fetchMembers({ force = false, refresh = false } = {}) {
  if (!force && !refresh) {
    try {
      const raw = localStorage.getItem(MEMBERS_CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts < MEMBERS_TTL_MS) {
          return cached.members;
        }
      }
    } catch (e) { /* ignore */ }
  }

  let data = null;
  try {
    const url = '/api/members' + (refresh ? '?refresh=1' : '');
    const r = await fetch(url, { method: 'GET' });
    if (r.ok) {
      data = await r.json();
    } else if (r.status !== 404) {
      // 404 는 "프록시 미배포" 로 간주하고 GAS 폴백.
      // 그 외 5xx 는 캐시된 stale 응답이 있으면 그것을 반환.
      console.warn('[api] /api/members HTTP', r.status, '— GAS 폴백 시도');
    }
  } catch (proxyErr) {
    console.warn('[api] /api/members 호출 실패, GAS 폴백:', proxyErr.message);
  }

  if (!data) {
    // 폴백: GAS 직접 호출 (개발 환경 또는 프록시 장애 시)
    data = await call('getMembers');
  }

  if (!data.ok) throw new Error(data.message || '회원 목록 조회 실패');
  try {
    localStorage.setItem(MEMBERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), members: data.members }));
  } catch (e) { /* quota full */ }
  return data.members;
}

export function clearMembersCache() {
  try { localStorage.removeItem(MEMBERS_CACHE_KEY); } catch (e) {}
}

// ============================================================
// 오프라인 체크인 큐
// ------------------------------------------------------------
// 네트워크가 일시적으로 불안정하면 fetch 가 실패/타임아웃 될 수 있는데,
// 출석 현장에서는 "회원이 도착했을 때 즉시 기록"이 중요하므로
// 실패한 체크인을 localStorage 에 저장해뒀다가 자동으로 재전송한다.
//
// 저장 항목:
//   { id, memberId, method, byVolunteer, clientTime (ISO), attempts }
// ============================================================

const QUEUE_KEY = 'attn.queue.v1';
const queueListeners = new Set();

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function writeQueue(q) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch (e) { /* quota */ }
  notifyQueueListeners(q.length);
}

function notifyQueueListeners(size) {
  queueListeners.forEach((fn) => {
    try { fn(size); } catch (e) {}
  });
}

export function onQueueChange(fn) {
  queueListeners.add(fn);
  // 초기값 즉시 통지
  try { fn(readQueue().length); } catch (e) {}
  return () => queueListeners.delete(fn);
}

export function getQueueSize() {
  return readQueue().length;
}

function enqueueCheckin(item) {
  const q = readQueue();
  q.push({
    id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
    memberId: item.memberId,
    method: item.method || 'qr',
    byVolunteer: !!item.byVolunteer,
    clientTime: new Date().toISOString(),
    attempts: 0,
  });
  writeQueue(q);
}

/**
 * 큐에 쌓인 체크인을 순서대로 재전송.
 * 중복 응답(duplicate)은 성공으로 간주하여 제거한다.
 */
let syncing = false;
export async function syncQueue() {
  if (syncing) return { processed: 0, remaining: readQueue().length, skipped: true };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { processed: 0, remaining: readQueue().length, offline: true };
  }
  syncing = true;
  let processed = 0;
  try {
    // 매번 최신 큐를 읽어 동시 수정에 안전하게 대응
    while (true) {
      const q = readQueue();
      if (q.length === 0) break;
      const item = q[0];
      try {
        const res = await call('checkIn', {
          memberId: item.memberId,
          method: item.method,
          byVolunteer: item.byVolunteer,
          clientTime: item.clientTime,
        });
        // 서버가 네트워크 수준으로 실패하지 않았다면(성공/중복/notfound 모두) 큐에서 제거
        const after = readQueue();
        after.shift();
        writeQueue(after);
        processed++;
        if (res && res.ok === false && res.status !== 'duplicate') {
          console.warn('[queue] 서버 거부:', res, '원본:', item);
        }
      } catch (err) {
        if (err && err.isNetworkError) {
          // 아직 네트워크가 불안정. 다음 트리거(online/interval)까지 대기.
          const after = readQueue();
          if (after[0] && after[0].id === item.id) {
            after[0].attempts = (after[0].attempts || 0) + 1;
            writeQueue(after);
          }
          break;
        }
        // 네트워크 외 에러는 재전송해도 해결되지 않으므로 버리고 넘어간다
        console.error('[queue] 치명적 오류, 항목 제거:', err, item);
        const after = readQueue();
        after.shift();
        writeQueue(after);
      }
    }
  } finally {
    syncing = false;
  }
  return { processed, remaining: readQueue().length };
}

/**
 * 체크인.
 * - 네트워크 실패 시 localStorage 큐에 저장하고 "queued" 상태의 낙관적 응답을 반환.
 * - 성공 시 서버 응답을 그대로 반환.
 */
export async function checkIn({ memberId, method, byVolunteer }) {
  // 오프라인이면 즉시 큐잉 (fetch 시도 없이 저장)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    enqueueCheckin({ memberId, method, byVolunteer });
    return {
      ok: true,
      status: 'queued',
      message: '오프라인 — 저장됨 (연결되면 자동 전송)',
      member: { id: memberId, name: memberId },
      time: new Date().toTimeString().slice(0, 8),
      queued: true,
    };
  }

  try {
    const res = await call(
      'checkIn',
      { memberId, method, byVolunteer, clientTime: new Date().toISOString() },
      { timeoutMs: 10000 }
    );
    // 네트워크가 돌아온 김에 쌓여 있던 큐도 같이 비운다 (비동기)
    if (readQueue().length > 0) { syncQueue().catch(() => {}); }
    return res;
  } catch (err) {
    if (err && err.isNetworkError) {
      enqueueCheckin({ memberId, method, byVolunteer });
      return {
        ok: true,
        status: 'queued',
        message: '네트워크 불안정 — 저장됨 (자동 재전송)',
        member: { id: memberId, name: memberId },
        time: new Date().toTimeString().slice(0, 8),
        queued: true,
      };
    }
    throw err;
  }
}

export async function getTodayStats() {
  const data = await call('getTodayStats');
  if (!data.ok) throw new Error(data.message || '통계 조회 실패');
  return data.stats;
}

export async function getDailyAttendance(date) {
  const data = await call('getDailyAttendance', { date });
  if (!data.ok) throw new Error(data.message || '일자별 참석자 조회 실패');
  return data.result;
}

export async function getAttendanceStats({ startDate, endDate }) {
  const data = await call('getAttendanceStats', { startDate, endDate });
  if (!data.ok) throw new Error(data.message || '기간 통계 조회 실패');
  return data.result;
}

export async function ping() {
  return call('ping');
}

// ------------------------------------------------------------
// 자동 동기화 트리거: 온라인 복귀 / 탭 가시화 / 15초 주기
// (브라우저 환경에서만 설치)
// ------------------------------------------------------------
if (typeof window !== 'undefined') {
  const trigger = () => {
    if (readQueue().length > 0) syncQueue().catch(() => {});
  };
  window.addEventListener('online', trigger);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') trigger();
  });
  // 15초 주기 폴링: 오프라인 상태에서도 회복을 곧바로 감지
  setInterval(trigger, 15000);
  // 첫 진입 시에도 한 번 시도
  trigger();
}
