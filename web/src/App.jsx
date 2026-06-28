import { useEffect, useState } from 'react';
import Checkin from './Checkin.jsx';
import Dashboard from './Dashboard.jsx';
import MyQr from './MyQr.jsx';

/**
 * 아주 가벼운 해시 기반 라우팅.
 * - #/          -> 체크인 화면 (입구 키오스크/자원봉사자)
 * - #/dashboard -> 실시간 출석 대시보드
 * - #/my-qr     -> 회원 셀프 QR 조회/다운로드
 */
// 호스트명이 QR 전용 주소이면 해시가 없을 때 자동으로 #/my-qr 로 보낸다.
// 판별 기준(OR):
//   1) 환경변수 VITE_MYQR_HOST 와 정확히 일치
//   2) 호스트명에 'myqr' 또는 'my-qr' 문자열이 포함
//   3) 호스트명이 'qr.', 'mycard.', 'card.' 로 시작
function isQrOnlyHost() {
  const host = window.location.hostname.toLowerCase();
  const envHost = (import.meta.env.VITE_MYQR_HOST || '').toLowerCase();
  if (envHost && host === envHost) return true;
  if (host.includes('myqr') || host.includes('my-qr')) return true;
  if (/^(qr|mycard|card)\./.test(host)) return true;
  return false;
}

function useHashRoute() {
  const [route, setRoute] = useState(() => {
    if (!window.location.hash && isQrOnlyHost()) {
      window.location.hash = '#/my-qr';
      return '#/my-qr';
    }
    return window.location.hash || '#/';
  });
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export default function App() {
  const route = useHashRoute();
  if (route.startsWith('#/dashboard')) return <Dashboard />;
  if (route.startsWith('#/my-qr')) return <MyQr />;
  return <Checkin />;
}
