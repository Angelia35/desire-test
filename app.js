/*
 * app.js — 状态机 + 评分引擎 + UI 渲染 + Canvas 结果卡
 * ---------------------------------------------------------------------------
 * 纯前端、无后端、无 API、无框架。
 * 评分引擎（computeScores / resolveResult）与展示解耦，可被 Node 自检直接调用。
 */
(function () {
  'use strict';

  // 数据来源：浏览器挂 window.DATA，Node 自检时挂 globalThis.DATA
  var DATA =
    (typeof window !== 'undefined' && window.DATA) ||
    (typeof globalThis !== 'undefined' && globalThis.DATA) ||
    null;

  // localStorage 键名
  var STATE_KEY = 'desire_test_state_v1';
  var RESULT_KEY = 'desire_test_result_v1';

  var TOTAL = DATA ? DATA.questions.length : 20;

  // =======================================================================
  // 评分引擎（纯函数，可在 Node 中复用）
  // =======================================================================

  // 理论最高分 = 题库中各类型出现机会数 × 每题分值。
  // 直接从题库推导，保证与题目一致（避免手写 maxScore 与题库脱节），
  // 归一化分恒 ≤ 1，百分比展示才正确；新增测试也无需改这里。
  function getMaxScores() {
    var m = {};
    DATA.questions.forEach(function (q) {
      q.options.forEach(function (o) {
        m[o.type] = (m[o.type] || 0) + DATA.scoring.perOption;
      });
    });
    return m;
  }

  // 由 answers（{ 题下标: 类型代码 }）计算原始分与归一化分
  function computeScores(answers) {
    answers = answers || {};
    var raw = { B: 0, F: 0, C: 0, R: 0, S: 0, N: 0 };
    for (var qi in answers) {
      if (Object.prototype.hasOwnProperty.call(answers, qi)) {
        var t = answers[qi];
        if (raw[t] !== undefined) raw[t] += DATA.scoring.perOption;
      }
    }
    var maxScore = getMaxScores();
    var norm = {};
    for (var k in raw) {
      if (Object.prototype.hasOwnProperty.call(raw, k)) {
        norm[k] = raw[k] / maxScore[k];
      }
    }
    return { raw: raw, norm: norm };
  }

  // 计算完整结果：排序 + 主/副类型 + 并列处理
  function resolveResult(answers) {
    answers = answers || {};
    var scores = computeScores(answers);
    var raw = scores.raw;
    var norm = scores.norm;

    var sorted = Object.keys(norm)
      .map(function (t) {
        return { type: t, raw: raw[t], norm: norm[t] };
      })
      .sort(function (a, b) {
        // 先按归一化分降序；并列时原始分高者优先
        if (b.norm !== a.norm) return b.norm - a.norm;
        return b.raw - a.raw;
      });

    var primary = sorted[0].type;
    var secondary = sorted[1].type;
    var isTie = false;
    var tieTypes = null;

    // 第一名与第二名归一化分完全相同 → 进入并列处理
    if (sorted[0].norm === sorted[1].norm) {
      var topNorm = sorted[0].norm;
      var tied = sorted
        .filter(function (s) {
          return s.norm === topNorm;
        })
        .map(function (s) {
          return s.type;
        });

      // 破平：只看最后 5 题（Q16~Q20），统计并列类型被实际选中的次数
      var last5 = DATA.scoring.lastFiveTiebreak;
      var counts = {};
      tied.forEach(function (t) {
        counts[t] = 0;
      });
      last5.forEach(function (qi) {
        var t = answers[qi];
        if (t && counts[t] !== undefined) counts[t]++;
      });

      var byCount = tied.slice().sort(function (a, b) {
        return counts[b] - counts[a];
      });

      if (byCount.length >= 2 && counts[byCount[0]] !== counts[byCount[1]]) {
        // 末 5 题次数不同 → 次数多者为主类型
        primary = byCount[0];
        secondary = byCount[1];
      } else {
        // 末 5 题仍完全相同 → 双核心型（明确禁止 random）
        isTie = true;
        tieTypes = [byCount[0], byCount[1]];
        primary = byCount[0];
        secondary = byCount[1];
      }
    }

    return {
      raw: raw,
      norm: norm,
      sorted: sorted,
      primary: primary,
      secondary: secondary,
      isTie: isTie,
      tieTypes: tieTypes
    };
  }

  // =======================================================================
  // 状态管理（localStorage）
  // =======================================================================
  var state = { status: 'idle', current: 0, answers: {} };

  function loadState() {
    try {
      var s = localStorage.getItem(STATE_KEY);
      if (!s) return null;
      var obj = JSON.parse(s);
      if (!obj || typeof obj !== 'object') return null;
      obj.answers = obj.answers || {};
      return obj;
    } catch (e) {
      return null;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐私模式等场景静默失败，不影响主流程 */
    }
  }

  function clearState() {
    try {
      localStorage.removeItem(STATE_KEY);
    } catch (e) {}
  }

  function loadResult() {
    try {
      var r = localStorage.getItem(RESULT_KEY);
      return r ? JSON.parse(r) : null;
    } catch (e) {
      return null;
    }
  }

  function saveResult(result) {
    try {
      localStorage.setItem(RESULT_KEY, JSON.stringify(result));
    } catch (e) {}
  }

  function clearResult() {
    try {
      localStorage.removeItem(RESULT_KEY);
    } catch (e) {}
  }

  // =======================================================================
  // 渲染工具
  // =======================================================================
  var app = null;

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function disclaimerHTML() {
    return (
      '<p class="disclaimer">' + esc(DATA.meta.disclaimer) + '</p>'
    );
  }

  // =======================================================================
  // 首页
  // =======================================================================
  function renderHome() {
    var hasProgress =
      state.status === 'in_progress' && Object.keys(state.answers).length > 0;
    var hasResult = state.status === 'completed' && loadResult();

    var infoHTML = DATA.meta.info
      .map(function (i) {
        return (
          '<div class="info-item"><span class="num">' +
          esc(i.label) +
          '</span><span class="unit">' +
          esc(i.unit) +
          '</span></div>'
        );
      })
      .join('');

    var actions;
    if (hasResult) {
      actions =
        '<button class="btn btn-primary" id="btn-view">查看上次结果</button>' +
        '<button class="btn btn-ghost" id="btn-restart">重新测试</button>';
    } else if (hasProgress) {
      actions =
        '<button class="btn btn-primary" id="btn-resume">继续上次测试</button>' +
        '<button class="btn btn-ghost" id="btn-restart">重新开始</button>';
    } else {
      actions = '<button class="btn btn-primary" id="btn-start">开始测试</button>';
    }

    var node = el(
      '<section class="screen home">' +
        '<span class="eyebrow">娱乐性格测试</span>' +
        '<h1>' +
        esc(DATA.meta.title) +
        '</h1>' +
        '<p class="subtitle">' +
        esc(DATA.meta.subtitle) +
        '</p>' +
        '<div class="info-row">' +
        infoHTML +
        '</div>' +
        '<p class="hint">' +
        esc(DATA.meta.hint) +
        '</p>' +
        '<div class="btn-stack">' +
        actions +
        '</div>' +
        disclaimerHTML() +
        '</section>'
    );

    app.innerHTML = '';
    app.appendChild(node);

    var start = document.getElementById('btn-start');
    var resume = document.getElementById('btn-resume');
    var view = document.getElementById('btn-view');
    var restart = document.getElementById('btn-restart');

    if (start) start.addEventListener('click', startFresh);
    if (resume)
      resume.addEventListener('click', function () {
        renderQuestion(state.current || 0);
      });
    if (view)
      view.addEventListener('click', function () {
        var r = loadResult();
        if (r) renderResult(r);
        else renderHome();
      });
    if (restart)
      restart.addEventListener('click', function () {
        clearState();
        clearResult();
        state = { status: 'idle', current: 0, answers: {} };
        renderHome();
      });
  }

  // =======================================================================
  // 答题页
  // =======================================================================
  function startFresh() {
    clearState();
    clearResult();
    state = { status: 'in_progress', current: 0, answers: {} };
    saveState();
    renderQuestion(0);
  }

  function renderQuestion(qi) {
    if (qi < 0) qi = 0;
    if (qi > TOTAL - 1) qi = TOTAL - 1;
    state.current = qi;
    saveState();

    var q = DATA.questions[qi];
    var chosen = state.answers[qi]; // 已选类型（用于回显）
    var progress = Math.round(((qi + 1) / TOTAL) * 100);

    var optionsHTML = q.options
      .map(function (o) {
        var selected = chosen === o.type ? ' selected' : '';
        return (
          '<button class="option' +
          selected +
          '" data-type="' +
          o.type +
          '">' +
          '<span class="mark">' +
          (selected ? '✓' : esc(o.key)) +
          '</span>' +
          '<span class="otext">' +
          esc(o.text) +
          '</span>' +
          '</button>'
        );
      })
      .join('');

    var prevDisabled = qi === 0 ? ' disabled' : '';

    var node = el(
      '<section class="screen quiz">' +
        '<div class="topbar">' +
        '<span class="qcount">' +
        String(qi + 1).padStart(2, '0') +
        ' / ' +
        TOTAL +
        '</span>' +
        '<button class="prev-btn" id="prev"' +
        prevDisabled +
        '>← 上一题</button>' +
        '</div>' +
        '<div class="progress"><div class="fill" style="width:' +
        progress +
        '%"></div></div>' +
        '<p class="question">' +
        esc(q.text) +
        '</p>' +
        '<div class="options">' +
        optionsHTML +
        '</div>' +
        '</section>'
    );

    app.innerHTML = '';
    app.appendChild(node);

    // 上一题
    var prevBtn = document.getElementById('prev');
    if (prevBtn && !prevBtn.disabled) {
      prevBtn.addEventListener('click', function () {
        renderQuestion(qi - 1);
      });
    }

    // 选项点击：即时反馈 -> 进入下一题
    var optionEls = node.querySelectorAll('.option');
    optionEls.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.disabled) return;
        var type = btn.getAttribute('data-type');
        // 记录答案（覆盖式，修改不会重复累计）
        state.answers[qi] = type;
        state.status = 'in_progress';
        saveState();

        // 视觉反馈：高亮选中，禁用其余
        optionEls.forEach(function (b) {
          b.disabled = true;
        });
        btn.classList.add('selected');
        btn.querySelector('.mark').textContent = '✓';

        // 100~200ms 后自动进入下一题（无“下一题”按钮）
        setTimeout(function () {
          if (qi + 1 < TOTAL) {
            renderQuestion(qi + 1);
          } else {
            finishTest();
          }
        }, 140);
      });
    });
  }

  // =======================================================================
  // 完成测试 -> 计算结果
  // =======================================================================
  function finishTest() {
    var result = resolveResult(state.answers);
    saveResult(result);
    state.status = 'completed';
    saveState();
    renderResult(result);
  }

  // =======================================================================
  // 结果页
  // =======================================================================
  function renderResult(result) {
    var types = DATA.types;
    var primaryT = types[result.primary];
    var secondaryT = types[result.secondary];

    // 顶部情绪价值
    var heroHTML;
    if (result.isTie && result.tieTypes) {
      var a = types[result.tieTypes[0]];
      var b = types[result.tieTypes[1]];
      heroHTML =
        '<p class="lead">你的隐藏欲望是</p>' +
        '<span class="core">双核心型</span>' +
        '<h2>' +
        esc(a.name) +
        ' × ' +
        esc(b.name) +
        '</h2>' +
        '<p class="double">你同时被两种需求强烈驱动</p>';
    } else {
      heroHTML =
        '<p class="lead">你的隐藏欲望是</p>' +
        '<span class="core">【' +
        esc(primaryT.coreResult) +
        '】</span>' +
        '<h2>' +
        esc(primaryT.name) +
        '</h2>' +
        '<p class="secondary">副隐藏欲望：<b>' +
        esc(secondaryT.keyword) +
        '</b></p>';
    }

    // 六维倾向条（按归一化分降序，转百分比，不叫“准确率”）
    var barsHTML = result.sorted
      .map(function (s) {
        var t = types[s.type];
        var pct = Math.round(s.norm * 100);
        return (
          '<div class="bar-row">' +
          '<span class="name">' +
          esc(t.name.replace('型', '')) +
          '</span>' +
          '<span class="track"><span class="bfill" style="width:' +
          pct +
          '%"></span></span>' +
          '<span class="pct">' +
          pct +
          '%</span>' +
          '</div>'
        );
      })
      .join('');

    // 完整解析（6 段）
    function block(title, body) {
      return (
        '<div class="block"><p class="t">' +
        esc(title) +
        '</p><p class="b">' +
        esc(body) +
        '</p></div>'
      );
    }
    var analysisHTML =
      '<div class="analysis">' +
      '<h3 class="sec">完整解析</h3>' +
      block('01 你真正想要什么', primaryT.want) +
      block('02 你真正害怕什么', primaryT.fear) +
      block('03 你在关系中的表现', primaryT.relationship) +
      block('04 你的优势', primaryT.strength) +
      block('05 你容易踩的坑', primaryT.pitfall) +
      block('06 给你的提醒', primaryT.reminder) +
      '</div>';

    var node = el(
      '<section class="screen result">' +
        '<div class="hero">' +
        heroHTML +
        '</div>' +
        '<div class="card bars">' +
        '<h3>你的六种倾向</h3>' +
        barsHTML +
        '</div>' +
        analysisHTML +
        '<div class="card-zone" id="card-zone"></div>' +
        '<div class="footer-actions">' +
        '<button class="btn btn-primary" id="gen-card">生成我的结果卡</button>' +
        '<button class="btn btn-ghost" id="retest">重新测试</button>' +
        '</div>' +
        disclaimerHTML() +
        '</section>'
    );

    app.innerHTML = '';
    app.appendChild(node);

    // 生成结果卡
    document.getElementById('gen-card').addEventListener('click', function () {
      generateCard(result);
    });

    // 重新测试：清空旧状态，回到第一题
    document.getElementById('retest').addEventListener('click', function () {
      clearState();
      clearResult();
      state = { status: 'in_progress', current: 0, answers: {} };
      saveState();
      renderQuestion(0);
    });
  }

  // =======================================================================
  // 结果卡（Canvas，1080 × 1440，纯前端生成，无服务器）
  // =======================================================================
  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function generateCard(result) {
    var types = DATA.types;
    var primaryT = types[result.primary];

    var W = 1080;
    var H = 1440;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');

    // 背景：奶白 + 柔和粉紫渐变
    var bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#fdeef5');
    bg.addColorStop(0.5, '#f4eefb');
    bg.addColorStop(1, '#eaf1fb');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 内卡片
    var pad = 70;
    var ix = pad;
    var iy = pad;
    var iw = W - pad * 2;
    var ih = H - pad * 2;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, ix, iy, iw, ih, 56);
    ctx.fill();
    ctx.save();
    ctx.shadowColor = 'rgba(150,120,170,0.18)';
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 14;
    roundRect(ctx, ix, iy, iw, ih, 56);
    ctx.fill();
    ctx.restore();

    var cx = W / 2;

    // 顶部标签
    ctx.fillStyle = '#8e63b8';
    ctx.font = '600 34px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('测测你最强的隐藏欲望', cx, iy + 110);

    // 分隔小圆点装饰
    ctx.fillStyle = '#f3a9bd';
    ctx.beginPath();
    ctx.arc(cx, iy + 150, 7, 0, Math.PI * 2);
    ctx.fill();

    // 类型名
    var grad = ctx.createLinearGradient(ix + 120, 0, ix + iw - 120, 0);
    grad.addColorStop(0, '#8e63b8');
    grad.addColorStop(1, '#d98aa6');
    ctx.fillStyle = grad;
    ctx.font = '800 116px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText(primaryT.name, cx, iy + 350);

    // 核心结果 pill
    var pillText = '“' + primaryT.coreResult + '”';
    ctx.font = '700 40px -apple-system, "PingFang SC", sans-serif';
    var pw = ctx.measureText(pillText).width + 80;
    var ph = 84;
    var px = cx - pw / 2;
    var py = iy + 410;
    var pg = ctx.createLinearGradient(px, py, px + pw, py);
    pg.addColorStop(0, 'rgba(201,160,230,0.22)');
    pg.addColorStop(1, 'rgba(243,185,198,0.22)');
    ctx.fillStyle = pg;
    roundRect(ctx, px, py, pw, ph, ph / 2);
    ctx.fill();
    ctx.fillStyle = '#8e63b8';
    ctx.fillText(pillText, cx, py + 54);

    // 结果文案（多行）
    ctx.fillStyle = '#3a3340';
    ctx.font = '500 40px -apple-system, "PingFang SC", sans-serif';
    var lines = primaryT.cardText.split('\n');
    var ly = iy + 640;
    var lh = 64;
    lines.forEach(function (ln) {
      ctx.fillText(ln, cx, ly);
      ly += lh;
    });

    // 底部
    ctx.fillStyle = '#a79fb0';
    ctx.font = '500 30px -apple-system, "PingFang SC", sans-serif';
    ctx.fillText('娱乐性格测试 · 仅供自我探索', cx, H - pad - 50);

    // 展示：转为图片供手机长按保存
    var zone = document.getElementById('card-zone');
    if (zone) {
      zone.innerHTML = '';
      var img = document.createElement('img');
      img.alt = primaryT.name + ' 结果卡';
      img.src = canvas.toDataURL('image/png');
      zone.appendChild(img);

      var regen = document.createElement('button');
      regen.className = 'btn btn-ghost';
      regen.textContent = '重新生成结果卡';
      regen.addEventListener('click', function () {
        generateCard(result);
      });
      zone.appendChild(regen);
      zone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // =======================================================================
  // 初始化
  // =======================================================================
  function init() {
    app = document.getElementById('app');
    var saved = loadState();
    if (saved) state = saved;
    renderHome();
  }

  // 浏览器：DOM 就绪后启动
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Node 自检导出（不影响浏览器运行）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      computeScores: computeScores,
      resolveResult: resolveResult,
      getMaxScores: getMaxScores,
      DATA: DATA,
      TOTAL: TOTAL
    };
  }
})();
