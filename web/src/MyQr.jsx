import { useEffect, useMemo, useState } from 'react';
import { fetchMembers } from './api.js';

/**
 * 회원 셀프 QR 조회 페이지 (#/my-qr)
 * - 회원번호 또는 이름으로 조회
 * - 인증 없이 바로 표시 (회원번호 자체가 체크인 시에도 공개되는 값이므로)
 * - 카드 전체(제목·QR·이름·회원번호·부서·안내)를 canvas 로 합성해 하나의 이미지로 노출.
 *   → 길게 눌러 저장해도 텍스트가 포함된 전체 카드가 사진첩에 저장된다.
 */

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "맑은 고딕", sans-serif';

function qrSrc(id, size = 600) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(
    id
  )}`;
}

async function renderCardBlob(member) {
  const dept = member['소속/부서'] || member['본원/지부'] || '';

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('QR 이미지 로드 실패'));
    img.src = qrSrc(member.id, 600);
  });

  // 레이아웃 (1x 기준 좌표 — 실제는 SCALE 배 해상도로 렌더)
  const LW = 600;
  const qrSize = 440;
  const qrY = 84;
  const textStartY = qrY + qrSize + 36;
  const nameH = 54;
  const idH = 32;
  const deptH = dept ? 30 : 0;
  const noteGap = 22;
  const noteH = 28;
  const LH = textStartY + nameH + idH + deptH + noteGap + noteH + 30;

  const SCALE = 2; // 레티나·인쇄 대응
  const canvas = document.createElement('canvas');
  canvas.width = LW * SCALE;
  canvas.height = LH * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LW, LH);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  ctx.fillStyle = '#64748b';
  ctx.font = `600 20px ${FONT_STACK}`;
  ctx.fillText('출석 체크인 카드', LW / 2, 32);

  ctx.drawImage(img, (LW - qrSize) / 2, qrY, qrSize, qrSize);

  let y = textStartY;

  ctx.fillStyle = '#0f172a';
  ctx.font = `700 34px ${FONT_STACK}`;
  ctx.fillText(member.name || '', LW / 2, y);
  y += nameH;

  ctx.fillStyle = '#64748b';
  ctx.font = `400 20px ${FONT_STACK}`;
  ctx.fillText(`회원번호 ${member.id}`, LW / 2, y);
  y += idH;

  if (dept) {
    ctx.font = `400 18px ${FONT_STACK}`;
    ctx.fillText(dept, LW / 2, y);
    y += deptH;
  }

  // 구분선
  y += 10;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(60, y);
  ctx.lineTo(LW - 60, y);
  ctx.stroke();
  y += 12;

  ctx.fillStyle = '#64748b';
  ctx.font = `400 15px ${FONT_STACK}`;
  ctx.fillText('입장 시 이 QR 코드를 스캔해 주세요', LW / 2, y);

  return await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))),
      'image/png'
    );
  });
}

export default function MyQr() {
  const [members, setMembers] = useState([]);
  const [loadStatus, setLoadStatus] = useState('회원 정보를 불러오는 중…');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState(null);

  // 합성된 카드 이미지
  const [cardBlob, setCardBlob] = useState(null);
  const [cardUrl, setCardUrl] = useState(null);
  const [cardError, setCardError] = useState(null);

  useEffect(() => {
    fetchMembers()
      .then((list) => {
        setMembers(list);
        setLoadStatus('');
      })
      .catch((err) => setLoadStatus('회원 정보 로드 실패: ' + err.message));
  }, []);

  // selected 변경 시 카드 이미지 재생성
  useEffect(() => {
    if (!selected) {
      setCardBlob(null);
      setCardUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setCardError(null);
      return;
    }

    let cancelled = false;
    let createdUrl = null;
    setCardError(null);
    // 기존 URL 즉시 해제하여 이전 카드가 잠깐 보이는 현상 방지
    setCardUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setCardBlob(null);

    renderCardBlob(selected)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setCardBlob(blob);
        setCardUrl(createdUrl);
      })
      .catch((err) => {
        if (!cancelled) setCardError(err.message);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [selected]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || selected) return [];
    return members
      .filter((m) => m.id.indexOf(q) === 0 || (m.name && m.name.toLowerCase().indexOf(q) >= 0))
      .slice(0, 10);
  }, [query, members, selected]);

  const handleLookup = () => {
    const q = query.trim();
    if (!q) return;
    const exact = members.find((m) => m.id === q);
    if (exact) {
      setSelected(exact);
      setError(null);
      return;
    }
    if (suggestions.length === 1) {
      setSelected(suggestions[0]);
      setError(null);
      return;
    }
    if (suggestions.length === 0) {
      setError('일치하는 회원이 없습니다. 회원번호 또는 이름을 다시 확인해 주세요.');
    } else {
      setError('후보가 여러 명입니다. 아래 목록에서 본인을 선택하세요.');
    }
  };

  const handlePrint = () => window.print();

  // 버튼 저장: 모바일은 공유 시트의 "이미지 저장"으로 사진첩 직행, 그 외엔 다운로드
  const handleDownload = async () => {
    if (!selected || !cardBlob) return;
    const filename = `QR_${selected.id}_${selected.name || ''}.png`;
    try {
      const file = new File([cardBlob], filename, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: '내 QR 코드' });
          return;
        } catch (shareErr) {
          if (shareErr.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(cardBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      alert(
        '저장에 실패했습니다: ' + err.message + '\n\n' +
        '대신 카드 이미지를 길게 눌러 "이미지 저장"을 사용해 주세요.'
      );
    }
  };

  const reset = () => {
    setSelected(null);
    setQuery('');
    setError(null);
  };

  // ===== 선택 완료 → 카드 화면 =====
  if (selected) {
    return (
      <div className="container myqr">
        <div className="no-print toolbar">
          <button className="link" onClick={reset}>← 다시 조회</button>
          <div style={{ flex: 1 }} />
          <button className="secondary" onClick={handleDownload} disabled={!cardBlob}>
            QR 이미지 저장
          </button>
          <button onClick={handlePrint}>인쇄</button>
        </div>

        <div className="no-print save-hint">
          💡 "QR 이미지 저장" 버튼을 누르거나, 아래 카드 이미지를 길게 눌러 사진첩에 저장할 수 있어요.
        </div>

        <div className="print-card card-image-wrap" id="printCard">
          {cardUrl ? (
            <img
              className="card-image"
              src={cardUrl}
              alt={`${selected.name} 출석 체크인 카드`}
            />
          ) : cardError ? (
            <div className="card-loading error">
              카드 생성 실패: {cardError}
              <br />
              새로고침 후 다시 시도해 주세요.
            </div>
          ) : (
            <div className="card-loading">카드 생성 중…</div>
          )}
        </div>
      </div>
    );
  }

  // ===== 조회 입력 화면 =====
  return (
    <div className="container myqr">
      <header>
        <h1>내 QR 코드</h1>
        <a className="link" href="#/">체크인 화면</a>
      </header>

      <div className="card">
        <div className="status">{loadStatus}</div>
        <div className="row">
          <input
            type="text"
            inputMode="search"
            placeholder="회원번호 또는 이름 입력"
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleLookup(); }}
          />
          <button onClick={handleLookup}>조회</button>
        </div>

        {error && (
          <div className="meta" style={{ color: 'var(--error)', marginTop: 8 }}>
            {error}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="results">
            {suggestions.map((m) => (
              <div key={m.id} className="result-item" onClick={() => { setSelected(m); setError(null); }}>
                <div className="name">
                  {m.name} <span className="meta">({m.id})</span>
                </div>
                <div className="meta">{m['소속/부서'] || m['본원/지부'] || ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="status center">
        회원번호 또는 이름을 입력하고 조회 버튼을 누르면 본인의 QR 코드가 표시됩니다.
      </div>
    </div>
  );
}
