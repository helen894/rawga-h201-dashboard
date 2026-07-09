/**
 * priority.js — 규칙 기반 우선순위 엔진 (SPEC §4)
 *
 * 철학: 순위는 규칙(rules 테이블 config)이 정한다 — 투명·재현·조정 가능.
 * LLM은 상위 항목 설명만 담당(별도 Step 8), 순위 판단에 관여하지 않음.
 *
 * 점수 공식 (SPEC 4.2 의사코드 순서 그대로):
 *   ① deadline = 마감보너스(지연50/오늘30/이번주15) × (weights.deadline / 0.40)
 *   ② requester = 등급boost(대표40/핵심20/일반0) × (weights.requester / 0.25)
 *   ③ (①+②) × 축효과   — 축효과 = 1 + (axis_multiplier−1) × (weights.axis / 0.20)
 *   ④ + 담당자없음 페널티(원점수 가산, SPEC 의사코드대로) + 부하 × (weights.load / 0.15)
 *
 *   정규화 상수 K = 1/기본가중치 방식: 기본 가중치에서 보너스가 액면가 그대로 반영되고,
 *   슬라이더는 각 요소를 0~n배로 상대 조정한다. (예: weights.deadline 0.40→0.80이면 마감 영향 2배)
 *
 * 날짜: 저장은 UTC, "오늘/이번주" 판정은 KST(Asia/Seoul) 기준. 주 = 월~일.
 *
 * 사용: 브라우저 <script src="priority.js"> → window.PriorityEngine
 *       Node(테스트) → module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PriorityEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_WEIGHTS = { deadline: 0.40, requester: 0.25, axis: 0.20, load: 0.15 };
  // 완료 판정: Lists status 라벨이 자유 텍스트라 키워드 기반
  var DONE_RE = /완료|done|complete|closed|해결|취소/i;
  var LOAD_CAP = 10; // 부하 계수 상한 (담당자별 미완료 건수, 이 이상은 동일 취급)

  // ── KST 날짜 유틸 ─────────────────────────────────────────
  function kstDateStr(d) {
    // Date → 'YYYY-MM-DD' (Asia/Seoul 기준)
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
  }
  function addDaysStr(dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return t.toISOString().slice(0, 10);
  }
  function dayOfWeek(dateStr) { // 0=일 … 6=토
    var p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }
  function daysUntil(dueDate, todayStr) {
    // due − today (일 단위, 음수 = 지연). due 없으면 null
    if (!dueDate) return null;
    var a = String(dueDate).slice(0, 10).split('-').map(Number);
    var b = todayStr.split('-').map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 86400000);
  }
  /** 마감 버킷: 'overdue' | 'today' | 'this_week' | 'later' | 'none' (주 = 월~일, KST) */
  function dueBucket(dueDate, todayStr) {
    if (!dueDate) return 'none';
    var due = String(dueDate).slice(0, 10);
    if (due < todayStr) return 'overdue';
    if (due === todayStr) return 'today';
    var dow = dayOfWeek(todayStr);
    var sunday = addDaysStr(todayStr, dow === 0 ? 0 : 7 - dow); // 이번주 일요일
    return due <= sunday ? 'this_week' : 'later';
  }

  // ── 요청자 등급 ───────────────────────────────────────────
  /** 슬랙 표시명이 "이름/부서" 형식인 워크스페이스가 있어 '/' 앞부분으로 정규화 */
  function baseName(name) {
    return String(name).trim().split('/')[0].trim();
  }
  /** 이름 → 등급명. 미등록자/이름없음은 '일반' (SPEC 4.2). 완전일치 또는 기본이름 일치 */
  function lookupTier(name, rules) {
    if (!name) return '일반';
    var tiers = (rules && rules.requester_tiers) || {};
    var trimmed = String(name).trim();
    var base = baseName(trimmed);
    for (var tier in tiers) {
      var members = tiers[tier].members || [];
      for (var i = 0; i < members.length; i++) {
        var m = String(members[i]).trim();
        if (m === trimmed || baseName(m) === base) return tier;
      }
    }
    return '일반';
  }

  // ── 정규화: 3개 테이블 → 공통 아이템 ─────────────────────
  /**
   * @param data { tasks, listItems, mentions } — Supabase 행 배열 그대로
   * @returns 공통 아이템 배열 { key, axis, kind, title, assignee, requester,
   *          due_date, status, url, open, meta }
   */
  function normalize(data) {
    var items = [];
    (data.tasks || []).forEach(function (t) {
      items.push({
        key: 'task:' + t.task_id, axis: 'rawga', kind: 'task',
        title: t.name || '(제목 없음)',
        assignee: t.assignee || null, requester: t.requester || null,
        due_date: t.due_date || null, status: t.status || null,
        url: t.permalink_url || null,
        open: !DONE_RE.test(t.status || ''),
        meta: { project: t.project || null, task_gid: t.task_id }
      });
    });
    (data.listItems || []).forEach(function (li) {
      items.push({
        key: 'list:' + li.list_item_id, axis: 'h201', kind: 'list_item',
        title: li.title || '(제목 없음)',
        assignee: li.assignee || null, requester: null,
        due_date: li.due_date || null, status: li.status || null,
        url: li.permalink || null,
        open: !DONE_RE.test(li.status || ''),
        meta: { channel_id: li.channel_id || null, list_item_id: li.list_item_id }
      });
    });
    (data.mentions || []).forEach(function (m) {
      items.push({
        key: 'mention:' + m.message_ts, axis: 'h201', kind: 'mention',
        title: (m.text || '').slice(0, 120) || '(내용 없음)',
        assignee: null, requester: m.author || null,
        due_date: null, status: null,
        url: m.permalink || null,
        open: true, // 멘션은 상태 개념 없음 — SPA에서 로컬 처리(숨김) 예정
        meta: { channel_id: m.channel_id || null, message_ts: m.message_ts, thread_ts: m.thread_ts || null }
      });
    });
    return items;
  }

  // ── 점수 계산 ─────────────────────────────────────────────
  function relWeight(rules, key) {
    var w = (rules.weights || {})[key];
    return w == null ? 1 : w / DEFAULT_WEIGHTS[key];
  }

  function scoreItem(item, rules, ctx) {
    // ① 마감
    var bucket = dueBucket(item.due_date, ctx.todayStr);
    var dBonus = bucket === 'overdue' ? (rules.overdue_bonus || 0)
      : bucket === 'today' ? (rules.due_today_bonus || 0)
      : bucket === 'this_week' ? (rules.due_this_week_bonus || 0) : 0;
    var deadline = dBonus * relWeight(rules, 'deadline');

    // ② 요청자
    var tier = lookupTier(item.requester, rules);
    var boost = ((rules.requester_tiers || {})[tier] || {}).boost || 0;
    var requester = boost * relWeight(rules, 'requester');

    // ③ 축 (배수형 — weights.axis로 효과 강도 조절)
    var mult = (rules.axis_multiplier || {})[item.axis];
    if (mult == null) mult = 1;
    var axisEffect = 1 + (mult - 1) * relWeight(rules, 'axis');
    var s = (deadline + requester) * axisEffect;

    // ④ 부하 (멘션은 담당자 개념이 없어 페널티 제외)
    var noAssignee = (!item.assignee && item.kind !== 'mention') ? (rules.no_assignee_penalty || 0) : 0;
    var loadFactor = item.assignee ? Math.min(ctx.loadByAssignee[item.assignee] || 0, LOAD_CAP) : 0;
    var load = loadFactor * relWeight(rules, 'load');
    s += noAssignee + load;

    // 사람이 읽는 근거 (UI 표시용)
    var reasons = [];
    var dd = daysUntil(item.due_date, ctx.todayStr);
    if (bucket === 'overdue') reasons.push('지연 D+' + (-dd));
    else if (bucket === 'today') reasons.push('오늘 마감');
    else if (bucket === 'this_week') reasons.push('이번주 마감 (D-' + dd + ')');
    if (boost > 0) reasons.push(tier + ' 요청 (' + item.requester + ')');
    if (mult !== 1) reasons.push(item.axis === 'h201' ? 'H201 축 ×' + mult : '로가 축 ×' + mult);
    if (noAssignee > 0) reasons.push('담당자 없음');
    if (loadFactor > 0) reasons.push('담당자 부하 ' + loadFactor + '건');

    return {
      score: Math.round(s * 10) / 10,
      breakdown: {
        bucket: bucket, deadline: deadline, tier: tier, requester: requester,
        axisEffect: Math.round(axisEffect * 100) / 100,
        noAssignee: noAssignee, load: load
      },
      reasons: reasons
    };
  }

  /**
   * 메인 진입점: 세 테이블 데이터 + rules config → 점수순 정렬 목록
   * @param data  { tasks, listItems, mentions }
   * @param rules rules 테이블의 config jsonb
   * @param opts  { now?: Date, includeClosed?: boolean }
   */
  function scoreAll(data, rules, opts) {
    opts = opts || {};
    var todayStr = kstDateStr(opts.now || new Date());
    var all = normalize(data);

    // 부하: 담당자별 미완료 건수 (양 축 합산)
    var loadByAssignee = {};
    all.forEach(function (it) {
      if (it.open && it.assignee) loadByAssignee[it.assignee] = (loadByAssignee[it.assignee] || 0) + 1;
    });

    var pool = opts.includeClosed ? all : all.filter(function (it) { return it.open; });
    var ctx = { todayStr: todayStr, loadByAssignee: loadByAssignee };
    var scored = pool.map(function (it) {
      var r = scoreItem(it, rules, ctx);
      it.score = r.score; it.breakdown = r.breakdown; it.reasons = r.reasons;
      return it;
    });

    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var ad = a.due_date || '9999-12-31', bd = b.due_date || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1; // 동점이면 마감 임박순
      return a.title < b.title ? -1 : 1;
    });

    return { items: scored, todayStr: todayStr, loadByAssignee: loadByAssignee };
  }

  return {
    scoreAll: scoreAll,
    normalize: normalize,
    scoreItem: scoreItem,
    dueBucket: dueBucket,
    daysUntil: daysUntil,
    lookupTier: lookupTier,
    kstToday: function () { return kstDateStr(new Date()); },
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    DONE_RE: DONE_RE
  };
});
