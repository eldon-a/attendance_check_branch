/**
 * 출석체크 시스템 - Google Apps Script
 *
 * 동작 개요
 * - "회원목록" 시트(원본 DB에서 import된 회원 정보)를 읽어 체크인 검색/스캔에 사용
 * - 체크인 발생 시 "출석_YYYY-MM-DD" 시트를 자동 생성/업데이트
 * - 같은 날 같은 회원의 중복 체크인은 방지(알림용 응답)
 * - 웹앱(doGet) 진입 시 page 파라미터로 체크인 화면/대시보드 분기
 *
 * 사용 방법은 README.md 참고
 */

// ===== 설정 =====
const CONFIG = {
  MEMBER_SHEET_NAME: '회원목록',          // 회원 정보가 들어있는 시트 이름
  MEMBER_ID_COL: '회원번호',
  MEMBER_NAME_COL: '성명',
  ATTENDANCE_PREFIX: '출석_',              // 일자별 시트 접두어 (출석_2026-04-11)
  QR_COLUMN_HEADER: 'QR코드',              // QR 이미지를 넣을 컬럼 헤더
  TIMEZONE: 'Asia/Seoul'
};

// ===== 웹앱 진입점 =====
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'checkin';
  let template;
  if (page === 'dashboard') {
    template = HtmlService.createTemplateFromFile('dashboard');
  } else {
    template = HtmlService.createTemplateFromFile('checkin');
  }
  template.webAppUrl = ScriptApp.getService().getUrl();
  return template.evaluate()
    .setTitle('출석체크 시스템')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===== 회원 목록 조회 =====
/**
 * 회원목록 시트를 읽어 [{id, name, status, branch, dept, ...}] 배열 반환
 * 클라이언트의 검색/자동완성에 사용
 */
function getMembers() {
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
    const id = row[idIdx];
    const name = row[nameIdx];
    if (id === '' || id === null) continue;

    const m = { id: String(id), name: String(name || '') };
    headers.forEach((h, i) => {
      if (h && h !== CONFIG.MEMBER_ID_COL && h !== CONFIG.MEMBER_NAME_COL && h !== CONFIG.QR_COLUMN_HEADER) {
        m[h] = row[i];
      }
    });
    members.push(m);
  }
  return members;
}

// ===== 체크인 처리 =====
/**
 * 체크인 등록
 * @param {Object} payload {memberId, method: 'qr'|'search', byVolunteer: boolean}
 * @return {Object} {ok, status: 'checked'|'duplicate'|'notfound', member, time}
 */
function checkIn(payload) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const memberId = String((payload && payload.memberId) || '').trim();
    const method = (payload && payload.method) || 'qr';
    const byVolunteer = !!(payload && payload.byVolunteer);

    if (!memberId) return { ok: false, status: 'notfound', message: '회원번호가 비어 있습니다.' };

    const members = getMembers();
    const member = members.find(m => m.id === memberId);
    if (!member) {
      return { ok: false, status: 'notfound', message: '회원번호 ' + memberId + ' 를 찾을 수 없습니다.' };
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const dateStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    const timeStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'HH:mm:ss');
    const sheetName = CONFIG.ATTENDANCE_PREFIX + dateStr;

    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      sheet.appendRow(['회원번호', '성명', '체크인시각', '방식', '대리입력', '비고']);
      sheet.setFrozenRows(1);
      sheet.getRange('A1:F1').setFontWeight('bold').setBackground('#e8f0fe');
      sheet.setColumnWidths(1, 6, 120);
    }

    // 중복 체크
    const data = sheet.getDataRange().getValues();
    for (let r = 1; r < data.length; r++) {
      if (String(data[r][0]) === memberId) {
        return {
          ok: false,
          status: 'duplicate',
          member: member,
          time: String(data[r][2]),
          message: member.name + ' 님은 이미 ' + data[r][2] + ' 에 체크인 되었습니다.'
        };
      }
    }

    sheet.appendRow([memberId, member.name, timeStr, method, byVolunteer ? 'Y' : 'N', '']);
    return {
      ok: true,
      status: 'checked',
      member: member,
      time: timeStr,
      message: member.name + ' 님 체크인 완료'
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ===== 대시보드용 통계 =====
function getTodayStats() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dateStr = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const sheetName = CONFIG.ATTENDANCE_PREFIX + dateStr;
  const members = getMembers();
  const total = members.length;

  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    return { date: dateStr, total: total, present: 0, absent: total, recent: [], absentList: members.slice(0, 200) };
  }

  const data = sheet.getDataRange().getValues();
  const presentIds = new Set();
  const recent = [];
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][0]);
    presentIds.add(id);
    recent.push({
      id: id,
      name: data[r][1],
      time: data[r][2],
      method: data[r][3],
      byVolunteer: data[r][4] === 'Y'
    });
  }
  recent.sort((a, b) => (b.time > a.time ? 1 : -1));

  const absentList = members.filter(m => !presentIds.has(m.id));
  return {
    date: dateStr,
    total: total,
    present: presentIds.size,
    absent: total - presentIds.size,
    recent: recent.slice(0, 20),
    absentList: absentList.slice(0, 200)
  };
}

// ===== QR 컬럼 일괄 생성 =====
/**
 * 회원목록 시트 끝에 'QR코드' 컬럼을 추가하고
 * 각 행에 IMAGE 함수로 외부 QR 생성기를 호출하는 수식을 채운다.
 *
 * 이미 QR 수식/값이 채워진 셀은 건너뛰고, 새로 추가된 회원(빈 셀)에만
 * QR을 생성한다. 메뉴에서 반복 실행해도 기존 QR은 그대로 유지된다.
 *
 * @param {boolean} [forceAll=false] true이면 전체 행을 덮어쓴다. (관리자용)
 */
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

  // 기존 QR 컬럼의 값/수식을 함께 읽어 "빈 셀"만 골라낸다.
  const idValues = sheet.getRange(2, idIdx + 1, lastRow - 1, 1).getValues();
  const qrValues = isNewColumn
    ? new Array(lastRow - 1).fill(['']).map(() => [''])
    : sheet.getRange(2, qrCol, lastRow - 1, 1).getValues();
  const qrFormulas = isNewColumn
    ? new Array(lastRow - 1).fill(['']).map(() => [''])
    : sheet.getRange(2, qrCol, lastRow - 1, 1).getFormulas();

  let added = 0;
  let skipped = 0;
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
      'QR 코드 생성 완료\n\n' +
      '신규 생성: ' + added + '명\n' +
      '기존 유지: ' + skipped + '명'
    );
  } catch (e) { /* 트리거/스크립트 호출 등 UI 컨텍스트 없음 */ }

  return { added: added, skipped: skipped };
}

/**
 * 전체 QR 컬럼을 강제로 다시 생성 (기존 값 덮어쓰기)
 */
function regenerateAllQrColumn() {
  return generateQrColumn(true);
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

// ===== 메뉴 =====
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('출석체크')
    .addItem('신규 회원 QR 생성', 'generateQrColumn')
    .addItem('전체 QR 재생성 (덮어쓰기)', 'regenerateAllQrColumn')
    .addSeparator()
    .addItem('웹앱 URL 보기', 'showWebAppUrl')
    .addToUi();
}

function showWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  SpreadsheetApp.getUi().alert(
    '체크인:  ' + url + '\n\n' +
    '대시보드: ' + url + '?page=dashboard'
  );
}
