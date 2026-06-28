/**
 * 출석체크 시스템 - Apps Script JSON API
 *
 * 이 스크립트는 React 프런트에서 fetch()로 호출하는 경량 JSON API로 동작합니다.
 * HTML 렌더링은 전혀 하지 않고, doPost 하나로 모든 액션을 받는 구조입니다.
 *
 * 지원 액션:
 *   - getMembers    : 회원 목록 (첫 로딩 시 1회 호출하여 클라이언트 캐싱)
 *   - checkIn       : 체크인 기록 {memberId, method, byVolunteer}
 *   - getTodayStats : 오늘 출석 현황
 *   - getDailyAttendance : 특정일 참석자 조회
 *   - getAttendanceStats : 기간별 회원 출입 통계
 *
 * CORS: 브라우저 preflight 를 피하기 위해 Content-Type: text/plain 으로 보내고,
 *       Apps Script 는 JSON 응답을 그대로 반환합니다.
 */

// ===== 설정 =====
const CONFIG = {
  MEMBER_SHEET_NAME: '회원목록',
  MEMBER_ID_COL: '회원번호',
  MEMBER_NAME_COL: '성명',
  ATTENDANCE_LOG_PREFIX: '출입기록_',
  QR_COLUMN_HEADER: 'QR코드',
  TIMEZONE: 'Asia/Seoul',
  MEMBER_CACHE_SECONDS: 60,  // 반복 호출 시 60초 CacheService 캐싱
  MAX_REPORT_DAYS: 366
};

// ===== 진입점 =====
function doGet(e) {
  // 헬스체크 + 기본 안내
  const action = (e && e.parameter && e.parameter.action) || '';
  if (action) return handleAction(action, e.parameter);

  return json({
    service: 'attendance-api',
    status: 'ok',
    actions: ['getMembers', 'checkIn', 'getTodayStats', 'getDailyAttendance', 'getAttendanceStats'],
    now: new Date().toISOString()
  });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json({ ok: false, error: 'invalid_json', message: err.message });
  }
  return handleAction(body.action, body);
}

function handleAction(action, payload) {
  try {
    switch (action) {
      case 'getMembers':     return json({ ok: true, members: getMembers() });
      case 'checkIn':        return json(checkIn(payload));
      case 'getTodayStats':  return json({ ok: true, stats: getTodayStats() });
      case 'getDailyAttendance':
        return json({ ok: true, result: getDailyAttendance(payload) });
      case 'getAttendanceStats':
        return json({ ok: true, result: getAttendanceStats(payload) });
      case 'ping':           return json({ ok: true, now: new Date().toISOString() });
      default:               return json({ ok: false, error: 'unknown_action', action: action });
    }
  } catch (err) {
    return json({ ok: false, error: 'server_error', message: err.message, stack: err.stack });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ===== 공통: 회원번호 정규화 =====
/**
 * 회원번호를 비교 가능한 표준 형태로 변환.
 * - 숫자/문자 타입 차이 제거
 * - 앞뒤 공백 및 모든 공백 문자(줄바꿈 포함) 제거
 * - 소수점 잔여(예: "1001.0") 제거
 */
function normalizeId(value) {
  if (value === null || value === undefined) return '';
  let s = String(value).trim();
  // 내부의 zero-width, non-breaking space, 개행 등 모두 제거
  s = s.replace(/[\s\u00A0\u200B\uFEFF]+/g, '');
  // 숫자처럼 보이는데 ".0" 이 붙은 경우 제거 (예: 1001.0 -> 1001)
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

// ===== 회원 목록 =====
function getMembers() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('members_v2');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.MEMBER_SHEET_NAME);
  if (!sheet) throw new Error('시트 "' + CONFIG.MEMBER_SHEET_NAME + '"를 찾을 수 없습니다.');

  const range = sheet.getDataRange().getValues();
  if (range.length < 2) return [];

  const headers = range[0].map(String);
  const idIdx = headers.indexOf(CONFIG.MEMBER_ID_COL);
  const nameIdx = headers.indexOf(CONFIG.MEMBER_NAME_COL);
  if (idIdx < 0 || nameIdx < 0) {
    throw new Error('"' + CONFIG.MEMBER_ID_COL + '" 또는 "' + CONFIG.MEMBER_NAME_COL + '" 컬럼을 찾을 수 없습니다.');
  }

  const members = [];
  for (let r = 1; r < range.length; r++) {
    const row = range[r];
    const normalizedId = normalizeId(row[idIdx]);
    if (!normalizedId) continue;
    const m = { id: normalizedId, name: String(row[nameIdx] || '').trim() };
    headers.forEach((h, i) => {
      if (h && h !== CONFIG.MEMBER_ID_COL && h !== CONFIG.MEMBER_NAME_COL && h !== CONFIG.QR_COLUMN_HEADER) {
        const v = row[i];
        m[h] = (v instanceof Date) ? Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd') : v;
      }
    });
    members.push(m);
  }

  try {
    cache.put('members_v2', JSON.stringify(members), CONFIG.MEMBER_CACHE_SECONDS);
  } catch (e) { /* 100KB 초과 시 무시 */ }
  return members;
}

// ===== 체크인 =====
function checkIn(payload) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const rawId = payload && payload.memberId;
    const memberId = normalizeId(rawId);
    const method = (payload && payload.method) || 'qr';
    const byVolunteer = !!(payload && payload.byVolunteer);
    if (!memberId) {
      return {
        ok: false,
        status: 'empty',
        message: '회원번호가 비어 있습니다. (수신값: "' + String(rawId == null ? '' : rawId) + '")',
        raw: String(rawId == null ? '' : rawId)
      };
    }

    const members = getMembers();
    let member = members.find(m => m.id === memberId);

    // 캐시가 오래되어 새 회원이 누락된 경우를 대비해 캐시를 비우고 재조회
    if (!member) {
      CacheService.getScriptCache().remove('members_v2');
      const fresh = getMembers();
      member = fresh.find(m => m.id === memberId);
    }

    if (!member) {
      return {
        ok: false,
        status: 'notfound',
        message: '회원번호 ' + memberId + ' 를 찾을 수 없습니다.',
        scanned: memberId
      };
    }

    // 클라이언트가 오프라인 큐에 저장했다가 재전송한 경우 clientTime(ISO 8601) 을
    // 전달받으므로, 그 시점을 기준으로 시트/시각을 계산해 실제 체크인 시점이 유지되게 한다.
    var recordedAt = new Date();
    if (payload && payload.clientTime) {
      var parsed = new Date(payload.clientTime);
      if (!isNaN(parsed.getTime())) recordedAt = parsed;
    }
    const dateStr = Utilities.formatDate(recordedAt, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    const timeStr = Utilities.formatDate(recordedAt, CONFIG.TIMEZONE, 'HH:mm:ss');
    const recordId = dateStr + '_' + memberId;
    const sheet = getAttendanceLogSheet(recordedAt, true);

    // 중복 체크: 같은 날짜 + 같은 회원번호는 1회만 기록
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const ids = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === recordId) {
          return {
            ok: false, status: 'duplicate',
            member: member, date: dateStr, time: String(ids[i][4]),
            message: member.name + ' 님은 이미 ' + dateStr + ' ' + ids[i][4] + ' 에 체크인 되었습니다.'
          };
        }
      }
    }

    // 오프라인 큐에서 늦게 올라온 기록은 method 뒤에 "(offline)" 태그를 붙여 구분
    var methodLabel = method;
    if (payload && payload.clientTime) {
      var deltaSec = Math.round((new Date().getTime() - recordedAt.getTime()) / 1000);
      if (deltaSec >= 30) methodLabel = method + '(offline+' + deltaSec + 's)';
    }
    sheet.appendRow([recordId, dateStr, memberId, member.name, timeStr, methodLabel, byVolunteer ? 'Y' : 'N', '']);
    return {
      ok: true, status: 'checked',
      member: member, date: dateStr, time: timeStr,
      message: member.name + ' 님 체크인 완료'
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ===== 통계 =====
function getTodayStats() {
  const dateStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const daily = getDailyAttendance({ date: dateStr });
  const members = getMembers();
  const presentIds = new Set(daily.attendees.map(function(r) { return r.id; }));
  const absentList = members.filter(function(m) { return !presentIds.has(m.id); });
  return {
    date: dateStr,
    total: daily.total,
    present: daily.present,
    absent: daily.total - daily.present,
    recent: daily.attendees.slice(0, 20),
    absentList: absentList.slice(0, 200)
  };
}

function getDailyAttendance(payload) {
  const dateStr = String((payload && payload.date) || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd')).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !parseYmd(dateStr)) {
    throw new Error('날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식으로 입력하세요.');
  }
  const members = getMembers();
  const total = members.length;
  const records = readAttendanceRecords(dateStr, dateStr);
  const latestByMember = {};
  records.forEach(function(r) {
    latestByMember[r.id] = r;
  });
  const attendees = Object.keys(latestByMember).map(function(id) {
    return latestByMember[id];
  });
  attendees.sort(function(a, b) {
    return b.time > a.time ? 1 : (b.time < a.time ? -1 : 0);
  });
  return {
    date: dateStr,
    total: total,
    present: attendees.length,
    attendees: attendees
  };
}

function getAttendanceStats(payload) {
  const startStr = String((payload && payload.startDate) || '').trim();
  const endStr = String((payload && payload.endDate) || '').trim();
  const startDate = parseYmd(startStr);
  const endDate = parseYmd(endStr);
  if (!startDate || !endDate || startDate > endDate) {
    throw new Error('시작일/종료일을 YYYY-MM-DD 형식으로 올바르게 입력하세요.');
  }
  const dates = listDates(startDate, endDate);
  if (dates.length > CONFIG.MAX_REPORT_DAYS) {
    throw new Error('조회 기간이 너무 깁니다. 최대 ' + CONFIG.MAX_REPORT_DAYS + '일까지만 조회하세요.');
  }

  const members = getMembers();
  const records = readAttendanceRecords(startStr, endStr);
  const byMember = {};
  records.forEach(function(r) {
    if (!byMember[r.id]) {
      byMember[r.id] = {
        id: r.id,
        name: r.name,
        dates: {},
        count: 0,
        firstDate: r.date,
        lastDate: r.date
      };
    }
    if (!byMember[r.id].dates[r.date]) {
      byMember[r.id].dates[r.date] = r.time || true;
      byMember[r.id].count++;
    }
    if (r.date < byMember[r.id].firstDate) byMember[r.id].firstDate = r.date;
    if (r.date > byMember[r.id].lastDate) byMember[r.id].lastDate = r.date;
  });

  const rows = members.map(function(m) {
    const item = byMember[m.id] || { id: m.id, name: m.name, dates: {}, count: 0, firstDate: '', lastDate: '' };
    const attendedDates = Object.keys(item.dates).sort();
    return {
      id: m.id,
      name: m.name,
      branch: m['소속/부서'] || m['본원/지부'] || '',
      count: item.count,
      attendanceRate: Math.round((item.count / dates.length) * 1000) / 10,
      firstDate: item.firstDate,
      lastDate: item.lastDate,
      attendedDates: attendedDates
    };
  });
  rows.sort(function(a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.name).localeCompare(String(b.name), 'ko');
  });

  return {
    startDate: startStr,
    endDate: endStr,
    days: dates.length,
    totalMembers: members.length,
    activeMembers: rows.filter(function(r) { return r.count > 0; }).length,
    totalRecords: records.length,
    rows: rows
  };
}

function getAttendanceLogSheet(dateObj, createIfMissing) {
  const year = Utilities.formatDate(dateObj, CONFIG.TIMEZONE, 'yyyy');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = CONFIG.ATTENDANCE_LOG_PREFIX + year;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet && createIfMissing) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['기록ID', '일자', '회원번호', '성명', '체크인시각', '방식', '대리입력', '비고']);
    sheet.setFrozenRows(1);
    sheet.getRange('A1:H1').setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setColumnWidths(1, 8, 120);
    sheet.setColumnWidth(1, 150);
  }
  return sheet;
}

function readAttendanceRecords(startStr, endStr) {
  const startDate = parseYmd(startStr);
  const endDate = parseYmd(endStr);
  if (!startDate || !endDate) return [];

  const records = [];
  const startYear = startDate.getFullYear();
  const endYear = endDate.getFullYear();
  for (var y = startYear; y <= endYear; y++) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.ATTENDANCE_LOG_PREFIX + y);
    if (!sheet || sheet.getLastRow() < 2) continue;
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
    for (var r = 0; r < values.length; r++) {
      const date = normalizeDateCell(values[r][1]);
      if (!date || date < startStr || date > endStr) continue;
      const id = normalizeId(values[r][2]);
      if (!id) continue;
      records.push({
        recordId: String(values[r][0] || ''),
        date: date,
        id: id,
        name: String(values[r][3] || ''),
        time: normalizeTimeCell(values[r][4]),
        method: String(values[r][5] || ''),
        byVolunteer: values[r][6] === 'Y',
        note: String(values[r][7] || '')
      });
    }
  }
  return records;
}

// ===== QR 컬럼 생성 (신규 회원만) =====
function generateQrColumn(forceAll) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.MEMBER_SHEET_NAME);
  if (!sheet) throw new Error('시트 "' + CONFIG.MEMBER_SHEET_NAME + '"가 없습니다.');

  const lastCol = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const idIdx = headers.indexOf(CONFIG.MEMBER_ID_COL);
  if (idIdx < 0) throw new Error('"' + CONFIG.MEMBER_ID_COL + '" 컬럼을 찾을 수 없습니다.');
  const idColLetter = columnToLetter(idIdx + 1);

  let qrIdx = headers.indexOf(CONFIG.QR_COLUMN_HEADER);
  let qrCol;
  let isNewColumn = false;
  if (qrIdx < 0) {
    qrCol = lastCol + 1;
    sheet.getRange(1, qrCol).setValue(CONFIG.QR_COLUMN_HEADER).setFontWeight('bold');
    isNewColumn = true;
  } else {
    qrCol = qrIdx + 1;
  }
  if (lastRow < 2) {
    if (isNewColumn) sheet.setColumnWidth(qrCol, 160);
    return { added: 0, skipped: 0 };
  }

  const idValues = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
  const qrValues = isNewColumn
    ? idValues.map(() => [''])
    : sheet.getRange(2, qrCol, lastRow - 1, 1).getValues();
  const qrFormulas = isNewColumn
    ? idValues.map(() => [''])
    : sheet.getRange(2, qrCol, lastRow - 1, 1).getFormulas();

  let added = 0, skipped = 0;
  for (let i = 0; i < idValues.length; i++) {
    const row = i + 2;
    const memberId = idValues[i][0];
    if (memberId === '' || memberId === null) continue;

    const hasExisting = !forceAll && (
      (qrFormulas[i][0] && String(qrFormulas[i][0]).trim() !== '') ||
      (qrValues[i][0] !== '' && qrValues[i][0] !== null)
    );
    if (hasExisting) { skipped++; continue; }

    const formula = '=IF(' + idColLetter + row + '="","",IMAGE("https://api.qrserver.com/v1/create-qr-code/?size=150x150&data="&' + idColLetter + row + '))';
    sheet.getRange(row, qrCol).setFormula(formula);
    sheet.setRowHeight(row, 150);
    added++;
  }
  if (isNewColumn) sheet.setColumnWidth(qrCol, 160);

  try {
    SpreadsheetApp.getUi().alert(
      'QR 코드 생성 완료\n\n신규 생성: ' + added + '명\n기존 유지: ' + skipped + '명'
    );
  } catch (e) {}
  return { added: added, skipped: skipped };
}

function regenerateAllQrColumn() { return generateQrColumn(true); }

// ===== 출석 리포트: 기간 지정 회원별 출석표 =====
/**
 * 특정 기간(시작일~종료일) 의 날짜별 출석 시트를 모아
 * "회원별 출석표" 시트를 새로 만든다.
 *
 * 출력 시트 구조:
 *   행 1: 헤더 (회원번호, 성명, [소속/부서], 2026-04-06, 2026-04-13, ..., 출석횟수, 출석률)
 *   행 2~: 회원별
 *     - 회원번호 / 성명 / (있다면) 소속·부서
 *     - 각 날짜 칸: 체크인 시각(HH:mm:ss) 또는 빈 칸
 *     - 맨 오른쪽: 출석 횟수, 출석률(%)
 *
 * UI에서 시작일/종료일을 YYYY-MM-DD 형식으로 입력받는다.
 */
function generateAttendanceReport() {
  const ui = SpreadsheetApp.getUi();
  const tz = CONFIG.TIMEZONE;
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const startResp = ui.prompt(
    '출석 리포트 생성 (1/2)',
    '시작일을 입력하세요 (YYYY-MM-DD)\n예: ' + today,
    ui.ButtonSet.OK_CANCEL
  );
  if (startResp.getSelectedButton() !== ui.Button.OK) return;
  const startStr = String(startResp.getResponseText() || '').trim();

  const endResp = ui.prompt(
    '출석 리포트 생성 (2/2)',
    '종료일을 입력하세요 (YYYY-MM-DD)\n예: ' + today,
    ui.ButtonSet.OK_CANCEL
  );
  if (endResp.getSelectedButton() !== ui.Button.OK) return;
  const endStr = String(endResp.getResponseText() || '').trim();

  buildAttendanceReport(startStr, endStr);
}

/** 이번 주(월~일) 리포트 */
function generateThisWeekReport() {
  const tz = CONFIG.TIMEZONE;
  const now = new Date();
  // getDay(): 0=일, 1=월, ... 6=토.  월요일 시작 기준으로 보정
  const dow = now.getDay();
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  buildAttendanceReport(
    Utilities.formatDate(mon, tz, 'yyyy-MM-dd'),
    Utilities.formatDate(sun, tz, 'yyyy-MM-dd')
  );
}

/** 이번 달(1일~말일) 리포트 */
function generateThisMonthReport() {
  const tz = CONFIG.TIMEZONE;
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  buildAttendanceReport(
    Utilities.formatDate(first, tz, 'yyyy-MM-dd'),
    Utilities.formatDate(last, tz, 'yyyy-MM-dd')
  );
}

/** 특정일 참석자 목록 시트 생성 */
function generateDailyAttendanceList() {
  const ui = SpreadsheetApp.getUi();
  const today = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const resp = ui.prompt(
    '특정일 참석자 목록 생성',
    '조회할 날짜를 입력하세요 (YYYY-MM-DD)\n예: ' + today,
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  buildDailyAttendanceList(String(resp.getResponseText() || '').trim());
}

function buildDailyAttendanceList(dateStr) {
  const ui = SpreadsheetApp.getUi();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !parseYmd(dateStr)) {
    ui.alert('날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식으로 입력하세요.');
    return;
  }

  CacheService.getScriptCache().remove('members_v2');
  const members = getMembers();
  const memberMap = {};
  members.forEach(function(m) {
    memberMap[m.id] = m;
  });

  const records = readAttendanceRecords(dateStr, dateStr);
  const latestByMember = {};
  records.forEach(function(r) {
    latestByMember[r.id] = r;
  });
  const attendees = Object.keys(latestByMember).map(function(id) {
    return latestByMember[id];
  });
  attendees.sort(function(a, b) {
    return a.time > b.time ? 1 : (a.time < b.time ? -1 : 0);
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = '참석자_' + dateStr;
  var sheet = ss.getSheetByName(sheetName);
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet(sheetName);
  }

  const summaryRows = [
    ['특정일 참석자 목록'],
    ['조회일', dateStr],
    ['참석 인원', attendees.length + '명'],
    ['전체 회원', members.length + '명'],
    ['생성 시각', Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm:ss')],
    ['']
  ];
  sheet.getRange(1, 1, summaryRows.length, 2).setValues(summaryRows.map(function(r) {
    return [r[0] || '', r[1] || ''];
  }));
  sheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);

  const headerRow = summaryRows.length + 1;
  const headers = ['순번', '회원번호', '성명', '소속/부서', '체크인시각', '방식', '대리입력', '비고'];
  sheet.getRange(headerRow, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8f0fe');

  const rows = attendees.map(function(r, idx) {
    const m = memberMap[r.id] || {};
    return [
      idx + 1,
      r.id,
      r.name,
      m['소속/부서'] || m['본원/지부'] || '',
      r.time,
      r.method,
      r.byVolunteer ? 'Y' : 'N',
      r.note || ''
    ];
  });
  if (rows.length > 0) {
    sheet.getRange(headerRow + 1, 1, rows.length, headers.length).setValues(rows);
  }

  sheet.setFrozenRows(headerRow);
  sheet.setColumnWidth(1, 60);
  sheet.setColumnWidth(2, 100);
  sheet.setColumnWidth(3, 100);
  sheet.setColumnWidth(4, 140);
  sheet.setColumnWidth(5, 100);
  sheet.setColumnWidth(6, 110);
  sheet.setColumnWidth(7, 80);
  sheet.setColumnWidth(8, 160);

  ss.setActiveSheet(sheet);
  ui.alert(
    '특정일 참석자 목록 생성 완료\n\n' +
    '시트: ' + sheetName + '\n' +
    '조회일: ' + dateStr + '\n' +
    '참석 인원: ' + attendees.length + '명'
  );
}

/**
 * 실제 리포트 생성 로직 (UI 프롬프트 없이 날짜 문자열만 받아 동작).
 * 테스트 및 프로그래밍 호출용.
 */
function buildAttendanceReport(startStr, endStr) {
  const ui = SpreadsheetApp.getUi();
  const tz = CONFIG.TIMEZONE;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
    ui.alert('날짜 형식이 올바르지 않습니다. YYYY-MM-DD 형식으로 입력하세요.');
    return;
  }
  const startDate = parseYmd(startStr);
  const endDate = parseYmd(endStr);
  if (!startDate || !endDate || startDate > endDate) {
    ui.alert('시작일이 종료일보다 뒤에 있습니다. 다시 확인하세요.');
    return;
  }

  // 기간 내 모든 날짜 목록
  const dates = [];
  const cursor = new Date(startDate.getTime());
  while (cursor <= endDate) {
    dates.push(Utilities.formatDate(cursor, tz, 'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate() + 1);
  }
  if (dates.length > CONFIG.MAX_REPORT_DAYS) {
    ui.alert('기간이 너무 깁니다 (최대 1년). 범위를 줄여 주세요.');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const records = readAttendanceRecords(startStr, endStr);
  const perDate = {};
  records.forEach(function(rec) {
    if (!perDate[rec.date]) perDate[rec.date] = {};
    perDate[rec.date][rec.id] = rec.time;
  });

  // 회원 목록 로드 (캐시 우회해서 최신값 확보)
  CacheService.getScriptCache().remove('members_v2');
  const members = getMembers();
  if (members.length === 0) {
    ui.alert('회원 목록이 비어 있습니다.');
    return;
  }

  // 선택 컬럼: 소속/부서 또는 본원/지부 중 첫 번째로 존재하는 것만 헤더에 포함
  const sampleMember = members[0];
  const extraKey = (sampleMember['소속/부서'] !== undefined)
    ? '소속/부서'
    : (sampleMember['본원/지부'] !== undefined ? '본원/지부' : null);

  // 헤더 구성
  const headers = ['회원번호', '성명'];
  if (extraKey) headers.push(extraKey);
  dates.forEach(function(d) { headers.push(d); });
  headers.push('출석횟수', '출석률(%)');

  // 데이터 행 구성
  const denom = dates.length;
  const rows = members.map(function(m) {
    const row = [m.id, m.name];
    if (extraKey) row.push(m[extraKey] || '');
    var count = 0;
    dates.forEach(function(d) {
      const map = perDate[d];
      if (map && map[m.id]) {
        row.push(map[m.id]);
        count++;
      } else {
        row.push('');
      }
    });
    row.push(count);
    row.push(Math.round((count / denom) * 1000) / 10); // 소수 1자리
    return row;
  });

  // 요약 계산
  const totalMembers = members.length;
  const activeMembers = rows.filter(function(r) { return r[r.length - 2] > 0; }).length;
  const neverAttended = totalMembers - activeMembers;

  // 출력 시트 (이미 있으면 덮어쓰기)
  const reportName = '리포트_' + startStr + '_' + endStr;
  var reportSheet = ss.getSheetByName(reportName);
  if (reportSheet) {
    reportSheet.clear();
  } else {
    reportSheet = ss.insertSheet(reportName);
  }

  // 상단 요약 블록
  const summaryRows = [
    ['출석 리포트'],
    ['기간', startStr + ' ~ ' + endStr],
    ['집계 대상 일수', dates.length + '일'],
    ['출입 기록 수', records.length + '건'],
    ['전체 회원', totalMembers + '명'],
    ['기간 내 1회 이상 출석', activeMembers + '명'],
    ['기간 내 미출석', neverAttended + '명'],
    [''], // 공백 한 줄
  ];
  reportSheet.getRange(1, 1, summaryRows.length, 2).setValues(summaryRows.map(function(r) {
    return [r[0] || '', r[1] || ''];
  }));
  reportSheet.getRange(1, 1).setFontWeight('bold').setFontSize(14);

  // 본문 시작 행
  const headerRow = summaryRows.length + 1;
  reportSheet.getRange(headerRow, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#e8f0fe');
  if (rows.length > 0) {
    reportSheet.getRange(headerRow + 1, 1, rows.length, headers.length).setValues(rows);
  }
  reportSheet.setFrozenRows(headerRow);
  reportSheet.setFrozenColumns(extraKey ? 3 : 2);

  // 컬럼 폭
  reportSheet.setColumnWidth(1, 90);
  reportSheet.setColumnWidth(2, 100);
  if (extraKey) reportSheet.setColumnWidth(3, 120);
  const dateColStart = extraKey ? 4 : 3;
  for (var c = 0; c < dates.length; c++) {
    reportSheet.setColumnWidth(dateColStart + c, 90);
  }
  reportSheet.setColumnWidth(dateColStart + dates.length, 80);      // 출석횟수
  reportSheet.setColumnWidth(dateColStart + dates.length + 1, 90);  // 출석률

  // 출석한 셀은 옅은 초록으로 음영
  if (rows.length > 0) {
    const bgRange = reportSheet.getRange(headerRow + 1, dateColStart, rows.length, dates.length);
    const bg = rows.map(function(r) {
      return dates.map(function(d, i) {
        const cell = r[dateColStart - 1 + i];
        return cell ? '#e6f4ea' : null;
      });
    });
    bgRange.setBackgrounds(bg);
  }

  // 출석률 퍼센트 포맷
  if (rows.length > 0) {
    reportSheet.getRange(headerRow + 1, dateColStart + dates.length + 1, rows.length, 1)
      .setNumberFormat('0.0');
  }

  ss.setActiveSheet(reportSheet);
  ui.alert(
    '출석 리포트 생성 완료\n\n' +
    '시트: ' + reportName + '\n' +
    '기간: ' + startStr + ' ~ ' + endStr + '\n' +
    '집계 대상 일수: ' + dates.length + '일\n' +
    '출석 회원: ' + activeMembers + ' / ' + totalMembers + '명'
  );
}

/**
 * 'YYYY-MM-DD' 문자열을 현지 자정(Asia/Seoul) 기준 Date 로 파싱.
 * 잘못된 입력이면 null 반환.
 */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const dt = new Date(y, mo - 1, d, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

function listDates(startDate, endDate) {
  const dates = [];
  const cursor = new Date(startDate.getTime());
  while (cursor <= endDate) {
    dates.push(Utilities.formatDate(cursor, CONFIG.TIMEZONE, 'yyyy-MM-dd'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function normalizeDateCell(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return '';
}

function normalizeTimeCell(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CONFIG.TIMEZONE, 'HH:mm:ss');
  return String(value || '');
}

function columnToLetter(col) {
  let letter = '';
  while (col > 0) {
    const mod = (col - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    col = Math.floor((col - mod) / 26);
  }
  return letter;
}

// ===== 스프레드시트 메뉴 =====
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('출석체크')
    .addItem('신규 회원 QR 생성', 'generateQrColumn')
    .addItem('전체 QR 재생성 (덮어쓰기)', 'regenerateAllQrColumn')
    .addSeparator()
    .addItem('특정일 참석자 목록 생성', 'generateDailyAttendanceList')
    .addSeparator()
    .addItem('출석 리포트 생성 (기간 지정)', 'generateAttendanceReport')
    .addItem('이번 주 리포트', 'generateThisWeekReport')
    .addItem('이번 달 리포트', 'generateThisMonthReport')
    .addSeparator()
    .addItem('API URL 보기', 'showApiUrl')
    .addItem('회원 캐시 비우기', 'clearMemberCache')
    .addToUi();
}

function showApiUrl() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(
    'API 엔드포인트\n\n' + url + '\n\n' +
    'React .env.local 에 아래와 같이 등록하세요:\n' +
    'VITE_API_URL=' + url
  );
}

function clearMemberCache() {
  const c = CacheService.getScriptCache();
  c.remove('members_v1');
  c.remove('members_v2');
  SpreadsheetApp.getUi().alert('회원 캐시를 비웠습니다. 다음 호출 시 새로 읽어옵니다.');
}

/**
 * 진단용: 특정 QR/ID 가 왜 매칭 안 되는지 확인할 때 Apps Script 편집기에서 실행.
 * Logs 창에서 정규화된 값과 매칭 여부 확인 가능.
 */
function debugLookup(rawId) {
  const normalized = normalizeId(rawId);
  const members = getMembers();
  const hit = members.find(m => m.id === normalized);
  Logger.log('입력: %s', JSON.stringify(rawId));
  Logger.log('정규화: %s', normalized);
  Logger.log('매칭 결과: %s', hit ? JSON.stringify(hit) : '없음');
  Logger.log('샘플 회원 5명: %s', JSON.stringify(members.slice(0, 5)));
  return { input: rawId, normalized: normalized, matched: hit || null, sample: members.slice(0, 5) };
}
