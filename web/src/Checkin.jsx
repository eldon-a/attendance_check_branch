import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  fetchMembers,
  checkIn as apiCheckIn,
  clearMembersCache,
  onQueueChange,
  syncQueue,
} from './api.js';

const READER_ID = 'qr-reader';

export default function Checkin() {
  const [members, setMembers] = useState([]);
  const [memberStatus, setMemberStatus] = useState('회원 정보를 불러오는 중…');
  const [tab, setTab] = useState('scan'); // 'scan' | 'search'
  const [byVolunteer, setByVolunteer] = useState(false);
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState(null); // {type, message}
  const [lastCheckin, setLastCheckin] = useState(null); // {member, time, status}
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null); // 확인 대기 중인 회원 {id, name, ...}
  const [facingMode, setFacingMode] = useState('environment'); // 'environment' | 'user'
  // null = 자동 감지 결과 사용, true/false = 사용자가 수동 오버라이드
  const [mirrorOverride, setMirrorOverride] = useState(null);
  const [scannerStatus, setScannerStatus] = useState('카메라 준비 중…');
  const [online, setOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );
  const [pendingCount, setPendingCount] = useState(0);

  const scannerRef = useRef(null);
  const lastScanRef = useRef({ code: '', at: 0 });
  const membersIndexRef = useRef(new Map()); // id -> member
  const lastCheckinTimerRef = useRef(null);

  // lastCheckin 은 5초 후 자동 제거 (다음 회원이 헷갈리지 않도록)
  useEffect(() => {
    if (!lastCheckin) return;
    if (lastCheckinTimerRef.current) window.clearTimeout(lastCheckinTimerRef.current);
    lastCheckinTimerRef.current = window.setTimeout(() => setLastCheckin(null), 5000);
    return () => {
      if (lastCheckinTimerRef.current) window.clearTimeout(lastCheckinTimerRef.current);
    };
  }, [lastCheckin]);

  // ----- 회원 로드 -----
  const loadMembers = useCallback(async (force = false) => {
    try {
      setMemberStatus('회원 정보를 불러오는 중…');
      const list = await fetchMembers({ force });
      setMembers(list);
      const idx = new Map();
      list.forEach(m => idx.set(m.id, m));
      membersIndexRef.current = idx;
      setMemberStatus(`총 ${list.length}명 회원 로드됨`);
    } catch (err) {
      setMemberStatus('회원 로드 실패: ' + err.message);
    }
  }, []);

  useEffect(() => { loadMembers(); }, [loadMembers]);

  // ----- 온라인/오프라인 상태 및 오프라인 큐 모니터링 -----
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const unsub = onQueueChange((size) => setPendingCount(size));
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      unsub();
    };
  }, []);

  // ----- 토스트 -----
  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), 2500);
  }, []);

  // ----- 체크인 -----
  const doCheckIn = useCallback(async (memberId, method) => {
    // 빈 값은 네트워크 왕복 없이 즉시 경고
    const cleaned = (memberId == null ? '' : String(memberId)).trim();
    if (!cleaned) {
      showToast('빈 QR 코드 또는 회원번호입니다. 다시 시도하세요.', 'error');
      return;
    }
    if (busy) return;

    setBusy(true);
    try {
      const res = await apiCheckIn({ memberId: cleaned, method, byVolunteer });
      if (res.ok && res.status === 'queued') {
        // 네트워크 불안정으로 localStorage 큐에 보관된 경우
        showToast(res.message, 'warn');
        setLastCheckin({
          member: res.member || { id: cleaned, name: cleaned },
          time: res.time,
          status: 'queued',
        });
      } else if (res.ok) {
        showToast(res.message, 'success');
        setLastCheckin({ member: res.member, time: res.time, status: 'ok' });
      } else if (res.status === 'duplicate') {
        showToast(res.message, 'warn');
        setLastCheckin({ member: res.member, time: res.time, status: 'dup' });
      } else {
        console.warn('[checkin] 실패 응답:', res, '전송한 값:', cleaned);
        showToast(res.message || '체크인 실패', 'error');
      }
    } catch (err) {
      showToast('오류: ' + err.message, 'error');
    } finally {
      setBusy(false);
    }
  }, [byVolunteer, busy, showToast]);

  // ----- QR 스캐너 라이프사이클 -----
  useEffect(() => {
    if (tab !== 'scan') return;

    let cancelled = false;
    const scanner = new Html5Qrcode(READER_ID);
    scannerRef.current = scanner;

    (async () => {
      try {
        setScannerStatus('카메라 목록 조회 중…');
        const cams = await Html5Qrcode.getCameras();
        if (cancelled) return;
        if (!cams || cams.length === 0) {
          setScannerStatus('카메라를 찾을 수 없습니다.');
          showToast('카메라를 찾을 수 없습니다.', 'error');
          return;
        }
        // facingMode에 맞는 카메라 선택
        let chosen;
        if (facingMode === 'user') {
          chosen = cams.find(c => /front|user|selfie|facetime/i.test(c.label)) || cams[0];
        } else {
          chosen = cams.find(c => /back|rear|environment/i.test(c.label)) || cams[cams.length - 1];
        }
        setScannerStatus(`카메라 시작 중… (${chosen.label || chosen.id})`);
        await scanner.start(
          chosen.id,
          {
            fps: 15,
            qrbox: { width: 280, height: 280 },
            aspectRatio: 1.0,
            // 브라우저 네이티브 BarcodeDetector 사용 시 인식률/속도 크게 향상
            experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          },
          (decoded) => {
            const now = Date.now();
            if (decoded === lastScanRef.current.code && now - lastScanRef.current.at < 3000) return;
            lastScanRef.current = { code: decoded, at: now };
            doCheckIn(String(decoded).trim(), 'qr');
          },
          () => {}
        );
        if (!cancelled) setScannerStatus('QR 코드를 스캔하세요');
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        setScannerStatus('카메라 시작 실패: ' + msg);
        showToast('카메라 시작 실패: ' + msg, 'error');
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      if (s && s.isScanning) {
        s.stop().then(() => { try { s.clear(); } catch (e) {} }).catch(() => {});
      } else if (s) {
        try { s.clear(); } catch (e) {}
      }
      scannerRef.current = null;
    };
  }, [tab, facingMode, doCheckIn, showToast]);

  // ----- 검색 자동완성 -----
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return members
      .filter(m => m.id.indexOf(q) === 0 || (m.name && m.name.toLowerCase().indexOf(q) >= 0))
      .slice(0, 20);
  }, [query, members]);

  const runSearch = () => {
    const q = query.trim();
    if (!q) return;
    const exact = membersIndexRef.current.get(q);
    if (exact) {
      setConfirmTarget(exact);
      return;
    }
    // suggestions 에서 첫 번째가 있으면 확인 대기
    if (suggestions.length === 1) {
      setConfirmTarget(suggestions[0]);
    }
  };

  const confirmCheckIn = () => {
    if (!confirmTarget) return;
    doCheckIn(confirmTarget.id, 'search');
    setConfirmTarget(null);
    setQuery('');
  };

  const cancelConfirm = () => {
    setConfirmTarget(null);
  };

  const refreshMembers = async () => {
    clearMembersCache();
    await loadMembers(true);
    showToast('회원 목록을 다시 불러왔습니다.', 'success');
  };

  return (
    <div className="container">
      <header>
        <h1>출석 체크인</h1>
        <div className="header-actions">
          <span
            className={`net-badge ${online ? 'on' : 'off'}`}
            title={online ? '온라인' : '오프라인 — 저장 후 자동 재전송'}
          >
            {online ? '● 온라인' : '● 오프라인'}
          </span>
          {pendingCount > 0 && (
            <button
              className="link pending"
              onClick={() => syncQueue()}
              title="미전송 체크인을 지금 다시 전송"
            >
              대기 {pendingCount}건 재전송
            </button>
          )}
          <button className="link" onClick={refreshMembers}>회원 새로고침</button>
          <a className="link" href="#/dashboard">대시보드</a>
        </div>
      </header>

      {lastCheckin && (
        <div className={`last-checkin ${lastCheckin.status}`}>
          <div className="name">{lastCheckin.member.name} 님</div>
          <div className="time">
            {lastCheckin.time}{' '}
            {lastCheckin.status === 'dup'
              ? '(중복)'
              : lastCheckin.status === 'queued'
              ? '(오프라인 저장됨)'
              : '체크인 완료'}
          </div>
        </div>
      )}

      <div className="card">
        <div className="tabs">
          <button className={`tab ${tab === 'scan' ? 'active' : ''}`} onClick={() => setTab('scan')}>QR 스캔</button>
          <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>직접 입력</button>
        </div>

        <div
          className={`panel ${tab === 'scan' ? '' : 'panel-disabled'}`}
          aria-hidden={tab !== 'scan'}
        >
          {/* 자동 판별 결과(기본): 전면 카메라는 미러링 적용, 후면은 적용 안 함.
              사용자가 수동 토글했다면 mirrorOverride 를 우선 사용한다. */}
          <div
            id={READER_ID}
            className={`reader ${
              (mirrorOverride == null ? facingMode === 'user' : mirrorOverride) ? 'mirrored' : ''
            }`}
          />
          <div className="scanner-toolbar">
            <button
              type="button"
              className="secondary small"
              onClick={(e) => {
                e.stopPropagation();
                setFacingMode((prev) => prev === 'environment' ? 'user' : 'environment');
                setMirrorOverride(null); // 카메라 전환 시 미러 자동 감지로 리셋
              }}
            >
              {facingMode === 'environment' ? '전면 카메라' : '후면 카메라'}로 전환
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={(e) => {
                e.stopPropagation();
                setMirrorOverride((prev) => {
                  const current = prev == null ? facingMode === 'environment' : prev;
                  return !current;
                });
              }}
            >
              화면 좌우 반전
            </button>
          </div>
          <div className="status">{tab === 'scan' ? scannerStatus : 'QR 스캔 (비활성)'}</div>
        </div>

        <div
          className={`panel ${tab === 'search' ? '' : 'panel-disabled'}`}
          aria-hidden={tab !== 'search'}
        >
          <div className="row">
            <input
              type="text"
              inputMode="search"
              placeholder="회원번호 또는 성명 입력"
              value={query}
              autoComplete="off"
              disabled={tab !== 'search'}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            />
            <button onClick={(e) => { e.stopPropagation(); runSearch(); }} disabled={tab !== 'search'}>검색</button>
          </div>
          {tab === 'search' && suggestions.length > 0 && (
            <div className="results">
              {suggestions.map(m => (
                <div key={m.id} className="result-item" onClick={() => { setConfirmTarget(m); }}>
                  <div className="name">{m.name} <span className="meta">({m.id})</span></div>
                  <div className="meta">{m['소속/부서'] || m['본원/지부'] || ''}</div>
                </div>
              ))}
            </div>
          )}
          {tab === 'search' && confirmTarget && (
            <div className="confirm-box">
              <div className="confirm-info">
                <div className="confirm-name">{confirmTarget.name}</div>
                <div className="confirm-meta">
                  회원번호: {confirmTarget.id}
                  {(confirmTarget['소속/부서'] || confirmTarget['본원/지부']) && (
                    <span> · {confirmTarget['소속/부서'] || confirmTarget['본원/지부']}</span>
                  )}
                </div>
              </div>
              <div className="confirm-msg">이 회원을 체크인하시겠습니까?</div>
              <div className="confirm-actions">
                <button className="confirm-btn primary" onClick={(e) => { e.stopPropagation(); confirmCheckIn(); }}>체크인</button>
                <button className="confirm-btn secondary" onClick={(e) => { e.stopPropagation(); cancelConfirm(); }}>취소</button>
              </div>
            </div>
          )}
          {tab === 'search' && query && suggestions.length === 0 && !confirmTarget && (
            <div className="results"><div className="meta">검색 결과 없음</div></div>
          )}
        </div>

        <label className="checkbox">
          <input type="checkbox" checked={byVolunteer} onChange={(e) => setByVolunteer(e.target.checked)} />
          자원봉사자 대리 입력
        </label>
      </div>

      <div className="status center">{memberStatus}</div>

      {toast && <div className={`toast show ${toast.type}`}>{toast.message}</div>}
    </div>
  );
}
