import { useEffect, useState } from 'react';
import { getAttendanceStats, getDailyAttendance, getTodayStats } from './api.js';

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function firstDayOfYear(date) {
  return `${date.getFullYear()}-01-01`;
}

export default function Dashboard() {
  const today = ymd(new Date());
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState('');

  const [dailyDate, setDailyDate] = useState(today);
  const [daily, setDaily] = useState(null);
  const [dailyError, setDailyError] = useState(null);
  const [dailyLoading, setDailyLoading] = useState(false);

  const [startDate, setStartDate] = useState(firstDayOfYear(new Date()));
  const [endDate, setEndDate] = useState(today);
  const [period, setPeriod] = useState(null);
  const [periodError, setPeriodError] = useState(null);
  const [periodLoading, setPeriodLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await getTodayStats();
        if (!alive) return;
        setStats(s);
        setLastUpdate(new Date().toLocaleTimeString());
        setError(null);
      } catch (err) {
        if (alive) setError(err.message);
      }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const loadDaily = async () => {
    setDailyLoading(true);
    try {
      const result = await getDailyAttendance(dailyDate);
      setDaily(result);
      setDailyError(null);
    } catch (err) {
      setDailyError(err.message);
    } finally {
      setDailyLoading(false);
    }
  };

  const loadPeriod = async () => {
    setPeriodLoading(true);
    try {
      const result = await getAttendanceStats({ startDate, endDate });
      setPeriod(result);
      setPeriodError(null);
    } catch (err) {
      setPeriodError(err.message);
    } finally {
      setPeriodLoading(false);
    }
  };

  useEffect(() => {
    loadDaily();
  }, []);

  return (
    <div className="container dashboard">
      <header>
        <h1>출입 현황 <span className="refresh">{stats?.date || ''}</span></h1>
        <a className="link" href="#/">체크인 화면</a>
      </header>

      {error && <div className="error-banner">오류: {error}</div>}

      <div className="stats">
        <div className="stat"><div className="label">전체 회원</div><div className="value">{stats?.total ?? '-'}</div></div>
        <div className="stat present"><div className="label">오늘 출입</div><div className="value">{stats?.present ?? '-'}</div></div>
        <div className="stat absent"><div className="label">오늘 미출입</div><div className="value">{stats?.absent ?? '-'}</div></div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>최근 체크인</h2>
          <div className="list">
            {(!stats || stats.recent.length === 0)
              ? <div className="meta">아직 체크인이 없습니다.</div>
              : stats.recent.map(r => (
                <div key={r.id + r.time} className="item">
                  <div>
                    <div className="name">{r.name} <span className="meta">({r.id})</span></div>
                    <div className="meta">{r.time} · {r.method === 'qr' ? 'QR' : '검색'}</div>
                  </div>
                  <span className={`badge ${r.byVolunteer ? 'vol' : ''}`}>
                    {r.byVolunteer ? '대리' : '셀프'}
                  </span>
                </div>
              ))
            }
          </div>
        </div>
        <div className="card">
          <h2>오늘 미출입 회원</h2>
          <div className="list">
            {(!stats || stats.absentList.length === 0)
              ? <div className="meta">전원 출입</div>
              : stats.absentList.map(m => (
                <div key={m.id} className="item">
                  <div>
                    <div className="name">{m.name} <span className="meta">({m.id})</span></div>
                    <div className="meta">{m['소속/부서'] || m['본원/지부'] || ''}</div>
                  </div>
                </div>
              ))
            }
          </div>
        </div>
      </div>

      <div className="grid query-grid">
        <div className="card">
          <h2>일자 참석자 조회</h2>
          <div className="query-row">
            <input type="date" value={dailyDate} onChange={(e) => setDailyDate(e.target.value)} />
            <button onClick={loadDaily} disabled={dailyLoading}>{dailyLoading ? '조회 중' : '조회'}</button>
          </div>
          {dailyError && <div className="error-banner compact">오류: {dailyError}</div>}
          <div className="summary-line">
            {daily ? `${daily.date} 참석 ${daily.present}명 / 전체 ${daily.total}명` : '날짜를 선택해 조회하세요.'}
          </div>
          <div className="list daily-list">
            {(!daily || daily.attendees.length === 0)
              ? <div className="meta">해당 날짜의 참석 기록이 없습니다.</div>
              : daily.attendees.map(r => (
                <div key={r.id + r.time} className="item">
                  <div>
                    <div className="name">{r.name} <span className="meta">({r.id})</span></div>
                    <div className="meta">{r.time} · {r.method === 'qr' ? 'QR' : '검색'}</div>
                  </div>
                  <span className={`badge ${r.byVolunteer ? 'vol' : ''}`}>{r.byVolunteer ? '대리' : '셀프'}</span>
                </div>
              ))
            }
          </div>
        </div>

        <div className="card">
          <h2>기간 회원별 통계</h2>
          <div className="query-row period-row">
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            <button onClick={loadPeriod} disabled={periodLoading}>{periodLoading ? '집계 중' : '집계'}</button>
          </div>
          {periodError && <div className="error-banner compact">오류: {periodError}</div>}
          <div className="summary-line">
            {period
              ? `${period.startDate} ~ ${period.endDate} · ${period.days}일 · 출입 회원 ${period.activeMembers}명 · 기록 ${period.totalRecords}건`
              : '기간을 선택해 회원별 출입 통계를 조회하세요.'}
          </div>
          <div className="table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>회원</th>
                  <th>소속</th>
                  <th>횟수</th>
                  <th>출입일</th>
                </tr>
              </thead>
              <tbody>
                {!period ? (
                  <tr><td colSpan="4" className="empty-cell">집계 결과가 없습니다.</td></tr>
                ) : period.rows.slice(0, 200).map(r => (
                  <tr key={r.id} className={r.count === 0 ? 'muted-row' : ''}>
                    <td>
                      <div className="name">{r.name}</div>
                      <div className="meta">{r.id}</div>
                    </td>
                    <td>{r.branch || '-'}</td>
                    <td>{r.count}</td>
                    <td>{r.attendedDates.length > 0 ? r.attendedDates.join(', ') : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {period && period.rows.length > 200 && (
            <div className="meta table-note">상위 200명만 표시됩니다. 전체 결과는 구글시트 리포트 메뉴를 사용하세요.</div>
          )}
        </div>
      </div>

      <div className="footer">10초마다 자동 새로고침 · 마지막 갱신 {lastUpdate}</div>
    </div>
  );
}
