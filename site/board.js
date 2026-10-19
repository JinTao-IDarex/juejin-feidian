/* board.js — 魔鬼榜单前端
 *
 * 三层：大封面 + 小卡条（首页）→ 赛道详情 → 逐张切牌。
 * 口径全部对齐 docs/devil-board-spec.md 第六、七节；落地时踩到的两个关键点：
 *
 *  1) **条数不固定（1~N）**：面包屑「共 N 张」、进度「第 x / 共 N 张」都动态；
 *     缩略进度是「固定宽轨道里放 N 个卡」（超出横滚），不是固定几格。
 *  2) **三种换法完全等价**：点箭头 / 键盘 ← → / 左右滑动。滑动跟手（松手前不播动画），
 *     阈值 = 牌宽 25%，拖动时箭头淡出让位。
 *
 * v0.9.0：首页从「六摞牌」改为「一张大牌 + 一条小卡」：
 *   上 = 当前赛道封面大牌（1:1.4），下 = 六张赛道小卡，点谁切谁；
 *   切赛道 = 左右切牌（与详情翻牌同一套 --dx 位移机制，.fx 复用 .cx 规则）。
 *   点大牌进详情仍是「飞行层 + clone」：大牌与详情大牌同为 1:1.4，
 *   单轴等比缩放落位，内容全程不变（飞的是 .bigcard 克隆）。
 *
 * v1.1：首页大牌区改为「扇形牌阵」（用户参考图的布局演示）：
 *   六张赛道牌**全部渲染**，当前赛道 ±2 落在扇面里（cur 居中最高无旋转，
 *   邻牌外旋下沉叠压约 1/3 牌宽），更远的沿扇面方向滑出并淡出（off-l/off-r）。
 *   切赛道 = 六张牌各自改 data-pos，由 CSS 过渡滑到新位次 —— 不再推 --dx、
 *   不重建 DOM（重建会把过渡打断成跳变）；中途再切只是重定目标，自然衔接。
 *   行内左右箭头已撤（扇出的侧牌会伸进箭头原来的位置）：侧牌可见部分 /
 *   空白左右半区 / 键盘 ←→ / 小卡条都能切，点中心牌进详情不变。
 *   悬停：中心牌上移放大（transform），两侧邻牌向外让步 —— 全程零重排。
 *
 * v1.1.1：扇面改**环形**（六张牌首尾相接）：原来选到首/末赛道时扇面缺成
 *   三张（「最旁边那张不见了」）；现在任何时刻都是满五张，恰好一张在扇外。
 *   换位 = 环上相邻一步（含 0↔5 环回），fstep 不再被两端卡死；
 *   环回断裂处（该从左进场的牌停在右侧扇外）由 fxTeleport 无感瞬移。
 */
(function () {
  'use strict';

  var q = new URLSearchParams(location.search);

  /* ---------------- 动效档（与 app.js 同口径） ----------------
   *
   * ⚠️ 为什么这里要把 app.js 的逻辑重抄一遍：board.html 只引 board.js、**不引 app.js**，
   *    而首页那三档动效（完整 / 轻量 / 跟随系统）持久化在 localStorage 里、
   *    落到 html.motion-lite / html.motion-full 两个类上。原来 board.js 只写了一句
   *    `matchMedia('(prefers-reduced-motion: reduce)').matches`，于是两个页面口径分裂：
   *      首页设「完整」+ 系统开了减少动效 → 首页有动画、**榜单页没动画**
   *      首页设「轻量」                  → 首页没动画、榜单页照旧播完整动画
   *    两边读同一份档位就一致了。另外原先那句是**加载时快照**：改了系统设置不刷新
   *    页面不会生效（app.js 那边是监听 change 的），这里也补上。
   *
   * 默认档同样是 'full' 而不是 'system' —— 理由与 app.js 一致：榜单的观感主要就靠
   * 这套切牌/飞行，不该被预览环境或系统设置静悄悄降级成「看起来没动画」。
   * URL 覆写（临时预览用，不落盘）：?motion=full|lite|system */
  var MOTION_MODES = ['full', 'lite', 'system'];
  var LKEY = 'juejin-gacha-glass';   // 与 app.js 同一个键（同源共享 localStorage）
  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  var urlMotion = (function () {
    var m = /[?&]motion=([a-z]+)/.exec(location.search);
    return m && MOTION_MODES.indexOf(m[1]) >= 0 ? m[1] : null;
  })();
  var motionMode = urlMotion || 'full';
  try {
    var mv = JSON.parse(localStorage.getItem(LKEY) || 'null');
    if (!urlMotion && mv && MOTION_MODES.indexOf(mv.motion) >= 0) motionMode = mv.motion;
  } catch (e) { /* 读不到就用默认档 */ }

  function resolveMotion() {
    var lite = motionMode === 'lite' || (motionMode === 'system' && motionQuery.matches);
    var root = document.documentElement;
    root.classList.toggle('motion-lite', lite);
    root.classList.toggle('motion-full', !lite);
  }
  resolveMotion();
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', resolveMotion);
  else if (motionQuery.addListener) motionQuery.addListener(resolveMotion);

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  var DUR = 320;        // 切牌 / 发牌
  var DUR_BACK = 240;   // 返回上一层（入场倒放，压短）
  var DUR_SNAP = 160;   // 未过阈值弹回

  /* 封面牌（摞）设计尺寸（= board.css 的 --cover-w / --cover-h）。
   * ⚠️ v0.9.0 六摞已撤，但这对常量是 check_extension.py 的尺寸契约锚点
   *    （与 --cover-w/h 同步、1:1.4），保留勿删。
   *    飞行层的实际设计尺寸由 FT_W/FT_H（首页大牌）决定，见 makeFlyer。 */
  var COVER_W = 202;
  var COVER_H = 283;

  /* 首页大封面牌设计尺寸（= board.css 的 --fw / --fh，站点档）。
   * 300x420 与详情大牌 396x554 同为 1:1.4 → 飞行仍是单轴等比缩放。
   * 浮层档是 240x336，但 scale = 视觉/设计，按 300 算照样成立（240/300=0.8）。 */
  var FT_W = 300;
  var FT_H = 420;

  /* ---------------- 赛道元数据（v0.8.0 发牌视图需要） ----------------
   *
   * ⭐ 为什么前端要抄一份：`TRACKS` 定义在 board-core.mjs（ESM），而 board.js 是
   *   普通 script，不能 import —— 更根本的原因是**发牌视图出现时还没有 S.data**：
   *   那一刻正在算第一手，payload 一片都没有，六摞的赛道名/色得先摆出来。
   *   所以只能前端自带一份静态元数据。
   *
   * ⚠️ 这份是 board-core.mjs `TRACKS` 的**手工副本**，改那边必须同步改这里。
   *   `scripts/check_extension.py` 有一条断言会比对两处的 id / name / def / color，
   *   对不上就构建失败 —— 别靠记性，靠那条断言。
   *   （只需要 id/name/def/color 四项：符号走上面的 SYMBOL，维度条发牌视图不画。） */
  var TRACKS = [
    { id: 'venom',    name: '毒舌榜', def: '骂得最狠，而且最准',   color: '#FF5A3C' },
    { id: 'absurd',   name: '离谱榜', def: '逻辑最崩，还理直气壮', color: '#F5A524' },
    { id: 'passive',  name: '阴阳榜', def: '表面客气，体内捅刀',   color: '#A855F7' },
    { id: 'stubborn', name: '嘴硬榜', def: '错了也绝不认',         color: '#1E80FF' },
    { id: 'blah',     name: '废话榜', def: '说了很多，等于没说',   color: '#454D57' },
    { id: 'emo',      name: 'emo 榜', def: '深夜破防，上班如上坟', color: '#12A173' },
  ];

  /* ---------------- 赛道符号（SVG，无 emoji，spec 第十节） ----------------
   * 图形形状以设计稿为准：毒舌=实心水滴 / 离谱=圈问号 / 阴阳=圆+右半实心 /
   * 嘴硬=素盾牌（设计稿里**没有**内嵌符号）/ 废话=气泡三点 / emo=雨云。
   *
   * ⚠️ 每个符号的 viewBox 必须「按图形自身包围盒收紧成正方形」（见 SYM_VB），
   *    不能统一写 0 0 16 16：六个图形在 16 格里原本大小差一倍
   *    （旧版火焰 6.6×9.3、太极 12.4×12.4），统一缩到 12px 后火焰只剩 5px，
   *    和设计稿那个 ~11px 的小徽章完全对不上。
   *    SYM_VB 的数值 = 浏览器 getBBox() 实测 → 按最大线宽/2 外扩 → 取正方形（×1.04 留边），
   *    六个都落在「12px 盒子里实占 11.54px」，与设计稿一致。
   *    **改了任一 path 就要重算它那一行 viewBox**，别手改。
   *    （重算脚本：把图形塞进一个 viewBox="0 0 16 16" 的 <svg> 里读 getBBox()。） */
  var SYMBOL = {
    venom: '<path d="M8 1.5C5.2 4.6 3.5 6.8 3.5 9.1a4.5 4.5 0 0 0 9 0c0-2.3-1.7-4.5-4.5-7.6z" fill="currentColor"/>',
    absurd: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 6.5c0-1.05.78-1.8 1.8-1.8s1.75.68 1.75 1.62c0 1.3-1.6 1.3-1.6 2.44" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="8.25" cy="10.6" r=".95" fill="currentColor"/>',
    passive: '<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/>',
    stubborn: '<path d="M8 1.7l5.2 2v4.2c0 3.1-2.1 5.6-5.2 6.5-3.1-.9-5.2-3.4-5.2-6.5V3.7l5.2-2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    blah: '<path d="M2.3 3.5h11.4v7.3H7.5l-3.3 2.7v-2.7H2.3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="5.6" cy="7.2" r=".95" fill="currentColor"/><circle cx="8" cy="7.2" r=".95" fill="currentColor"/><circle cx="10.4" cy="7.2" r=".95" fill="currentColor"/>',
    emo: '<path d="M4.7 10.5a2.9 2.9 0 01.3-5.7 3.7 3.7 0 016.9 1.1 2.4 2.4 0 01-.4 4.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5.6 12.1l-.7 1.7M8 12.1l-.7 1.7M10.4 12.1l-.7 1.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  };
  var SYM_VB = {
    venom: '1.708 1.258 12.584 12.584',
    absurd: '0.460 0.460 15.080 15.080',
    passive: '0.772 0.772 14.456 14.456',
    stubborn: '0.564 0.614 14.872 14.872',
    blah: '1.240 1.740 13.520 13.520',
    emo: '1.464 1.836 12.982 12.982',
  };
  /* 卡牌形象素材（都由 scripts/make_card_faces.py 从用户给的参考图里处理出来）：
   *   char-*  **从牌里抠出来的角色**（透明底）—— 封面牌的形象区用
   *   art-*   牌中间的插画带 —— 详情大牌的形象区用
   * ⚠️ 两个前缀互不为子串是刻意的：make_board_snapshot.py 靠
   *    [style*="url(cards/char-...)"] 这种**整路径子串**做内联，前缀相撞会互相命中。 */
  var CARD_CHAR = {
    venom: 'char-c1-vicious', absurd: 'char-c2-absurd', passive: 'char-c3-passive',
    stubborn: 'char-c4-stubborn', blah: 'char-c5-blah', emo: 'char-c6-emo',
  };
  var CARD_ART = {
    venom: 'art-c1-vicious', absurd: 'art-c2-absurd', passive: 'art-c3-passive',
    stubborn: 'art-c4-stubborn', blah: 'art-c5-blah', emo: 'art-c6-emo',
  };
  function sym(id, size) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="' + (SYM_VB[id] || '0 0 16 16') +
      '" aria-hidden="true" style="display:block">' + (SYMBOL[id] || '') + '</svg>';
  }

  /* ---------------- 卡面背景碎片（v1.0 贴纸风，用户给的参考图） ----------------
   *
   * 参考图里每张卡的角色背后都散着一组**贴纸碎片**，六个赛道各不相同
   * （毒舌=闪电/皇冠，废话=纸堆，emo=星星…），这是它「潮玩贴纸」观感的一半来源。
   *
   * ⭐ 用**矢量现画**，不用位图：
   *   ① 跟着赛道色走（currentColor）——改色值不用重出图，六张自动跟上；
   *   ② 不增加任何请求。首屏本来就要拉六张角色图（合计 ~690KB），
   *      再挂 6 张碎片 PNG 是纯浪费；
   *   ③ 碎片的「散落」是刻意的低信息量装饰，不适合走 `make_card_faces.py`
   *      那套抠图链（那套的产出是要精修的素材，不是几何图形）。
   *
   * 坐标系：viewBox 0 0 100 140 —— **与卡面同为 1:1.4**（300x420 / 240x336 都是），
   * 所以铺满即不变形，两档共用一套坐标。
   * 每条 = [形状, x, y, 缩放, 旋转]。形状定义在 0..10 的局部坐标里；
   * 一块 10 单位的图形按 scale=1 铺出来是 30px（1 单位 = 3px @站点档）。
   * ⚠️ 摆位要避开中间的形象区（x 26~74 / y 20~98），那里是角色；
   *    碎片全落在四角与左右边缘。 */
  var SHAPES = {
    bolt:  '<path d="M6 0 2.2 5.6h2.4L3.4 10 7.8 4.2H5.4z"/>',
    /* 皇冠要带底座：只画三个尖角缩到 20px 时像一座小山峰（emo 榜右侧实测如此），
     * 补一条底边才读得出是皇冠。 */
    crown: '<path d="M1 8.2 2.4 2.4 5 5.4 7.6 2.4 9 8.2z"/><rect x="1" y="8.3" width="8" height="1.6" rx=".5"/>',
    spark: '<path d="M5 0 6.3 3.7 10 5 6.3 6.3 5 10 3.7 6.3 0 5 3.7 3.7z"/>',
    sheet: '<path d="M1.6 1.2h5.2L9.2 3.6V10H1.6z" fill="none" stroke-width="1.1"/>',
    slash: '<path d="M0.6 10 9.4 0" fill="none" stroke-width="1.7" stroke-linecap="round"/>',
    dot:   '<circle cx="5" cy="5" r="2"/>',
    cloud: '<path d="M2.6 8.4a2.2 2.2 0 01.2-4.3 2.8 2.8 0 015.2.8 1.9 1.9 0 01-.3 3.5z" fill="none" stroke-width="1.1"/>',
    ring:  '<circle cx="5" cy="5" r="3.9" fill="none" stroke-width="1.2"/>',
  };
  var DECO = {
    venom:    [['bolt', 9, 24, 1.0, -14],  ['crown', 84, 27, 0.8, 8],
               ['slash', 7, 56, 0.7, 0],   ['slash', 90, 64, 0.6, 0],
               ['spark', 12, 76, 0.65, 0], ['bolt', 86, 86, 0.7, 18]],
    absurd:   [['sheet', 9, 26, 0.9, -10], ['ring', 85, 31, 0.75, 0],
               ['slash', 7, 58, 0.65, 0],  ['spark', 12, 78, 0.7, 0],
               ['dot', 90, 62, 0.5, 0],    ['dot', 83, 82, 0.6, 0]],
    passive:  [['sheet', 10, 30, 0.85, 12], ['sheet', 83, 24, 0.7, -8],
               ['bolt', 7, 60, 0.6, -12],  ['slash', 90, 60, 0.6, 0],
               ['spark', 13, 80, 0.65, 0], ['ring', 83, 86, 0.6, 0]],
    stubborn: [['slash', 8, 28, 0.9, 0],   ['slash', 88, 36, 0.75, 0],
               ['slash', 8, 62, 0.6, 0],   ['slash', 88, 68, 0.55, 0],
               ['dot', 14, 80, 0.55, 0],   ['spark', 83, 85, 0.7, 0]],
    blah:     [['sheet', 9, 24, 0.9, -10], ['sheet', 82, 32, 0.75, 8],
               ['cloud', 12, 74, 0.85, 0], ['slash', 90, 60, 0.55, 0],
               ['dot', 83, 82, 0.55, 0],   ['dot', 7, 58, 0.5, 0]],
    emo:      [['spark', 11, 26, 0.95, 0], ['ring', 84, 33, 0.7, 0],
               ['slash', 7, 58, 0.6, 0],   ['crown', 82, 80, 0.75, 8],
               ['spark', 14, 78, 0.65, 0], ['dot', 90, 62, 0.5, 0]],
  };
  function decoSVG(id) {
    var list = DECO[id] || [];
    if (!list.length) return '';
    return '<svg class="cv-deco" viewBox="0 0 100 140" preserveAspectRatio="none" aria-hidden="true">' +
      list.map(function (d) {
        return '<g transform="translate(' + d[1] + ' ' + d[2] + ') scale(' + d[3] + ')' +
          (d[4] ? ' rotate(' + d[4] + ')' : '') + '">' + (SHAPES[d[0]] || '') + '</g>';
      }).join('') + '</svg>';
  }

  /* ---------------- 状态 ---------------- */
  var S = {
    range: q.get('range') === 'week' ? 'week' : 'day',
    data: null,
    /* idle | building | ready | failed | none | loading | canceled
     * ◆canceled = **撤销后的「没评过」**（只有日榜首评撤销会走到）。
     *   与 none 的区别只在文案：日榜「没榜」只可能是被撤了或被失败打断，
     *   得说清「这是你撤掉的，不是坏了」。 */
    status: 'idle',
    progress: null,
    err: null,
    trackId: q.get('track') || null,
    idx: 0,
    fidx: 0,             // 首页当前选中的赛道下标（大牌 / 小卡条共用）
    busy: false,         // 正在播切牌/发牌动画
    pollErr: 0,          // 连续轮询失败次数（有界重试，见 load 的 catch）

    /* ---- v1.4 三段流程（决策 → 执行 → 交付）新增 ---- */
    pending: false,      // 有 /api/board 请求在飞（首拉与轮询都算）—— 按钮禁用的唯一来源
    canceling: false,    // ◆前端本地意图：点击那一帧置位，落定才清（驱动 busy 视觉 + 路由）
    cancelPoll: 0,       // 撤销期间已轮询的拍数（T16b 兜底：> 6 拍没落定就按本地状态收场）
    progSnap: null,      // ◆落定瞬间的最后一帧 S.progress（setStatus('ready') 会把它清成 null）
    prevCounts: null,    // 旧榜各赛道张数（算 delta 用）
    reqSeq: 0,           // 请求序号，回调里比对防竞态
    resultPhase: null,   // 'done' | 'empty' | 'stopped'，结果卡子态
    /* B1 的进程重启探测基线（scReset 新一轮时清零） */
    lastRunId: null, lastScanned: 0, lastPages: 0, restartNotified: false,
  };

  /* 结果卡自动关闭的计时器与暂停标记（只有「完成 · 有牌」会设） */
  var rsTimer = null, rsPaused = false, rsFilled = false;
  /* 撤销按钮的两段式（arm）倒计时 */
  var armTimer = null;
  /* toast 的定时器（连调时后者覆盖前者，不排队） */
  var toastTimer = null;

  var fslotEl = $('#fslot'), stripEl = $('#strip'), ftableEl = $('#ftable');
  var slotEl = $('#slot'), trackEl = $('#track');
  var viewDeal = $('#viewDeal'), viewDetail = $('#viewDetail'), sysEl = $('#sys');
  var tableEl = $('#table'), flyLayer = $('#flyLayer'), boardEl = $('#board');

  function board() {
    if (!S.data) return null;
    for (var i = 0; i < S.data.boards.length; i++) {
      if (S.data.boards[i].id === S.trackId) return S.data.boards[i];
    }
    return null;
  }
  /* 只认 html.motion-lite 一个类（由上面的 resolveMotion 落），不在这里再读
   * matchMedia —— 单一真相：媒体查询只在 resolveMotion 里解析一次。
   * ⚠️ 别改成 `!motionQuery.matches`：那会绕过首页的档位选择，回到口径分裂。 */
  function motion() { return !document.documentElement.classList.contains('motion-lite'); }

  /* ================= v1.4 · toast 驱动 =================
   * ⚠️ 既有缺口（ux-spec §7-7）：board.js 里**从来没有** toast 的 JS 驱动，
   *    .toast 只有 CSS 的 .on 类。这里补上：加 .on → 定时 → 去 .on。
   * 连续调用时**后者覆盖前者**（不排队）—— 撤销路径只可能有一条 toast，
   * 排队会让第二条迟到几秒，读起来像撒谎。
   * .toast 的 z-index:200 > .sc-mask 的 59 ⇒ 撤销 toast 能压在弹窗收起动画之上。 */
  function toast(msg, ms) {
    var el = $('#toast');
    if (!el) return;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    el.textContent = msg;
    el.classList.add('on');
    toastTimer = setTimeout(function () {
      el.classList.remove('on');
      toastTimer = null;
    }, ms || 2600);
  }

  /* ================= v1.4 · 按钮禁用：绑请求状态，不绑定时器 =================
   *
   * 现状是 `setTimeout(2500)` 解禁，三个问题（ux-spec §4.1）：
   *   ① 与实际请求时长无关 —— 真链路 1~2 分钟，2.5s 后就解禁了 ⇒ 能重复触发；
   *   ② 缓存命中只要 20ms，按钮却白锁 2.5s；
   *   ③ **更严重**：building 期间按钮完全可点 —— 点了就走 scReset() 把发牌台清零。
   * 改为绑 `S.pending`（请求在飞）+ `S.status`，解禁时机 = 请求返回后。
   *
   * ⚠️ syncButtons() **只写 disabled，绝不写文案**：轮询期间 S.pending 每 1.3s
   *    抖一次 true/false，写文案会让按钮抖。 */
  function syncButtons() {
    var base = S.pending || S.status === 'idle' || S.status === 'loading' ||
               S.status === 'building' || S.canceling;
    var f = $('#btnFresh');
    if (f) f.disabled = base;
    /* #cfGo 与 #btnFresh 同判据（确认条只在非 building 时出现，所以实际生效的是
     * S.pending / S.canceling） */
    var go = $('#cfGo');
    if (go) go.disabled = base;
    /* #cfNo **永不 disabled** —— 取消出口必须永远可达（紧急出口不能锁） */
    var sb = $('#sysBtn');
    if (sb) sb.disabled = S.pending || S.status === 'building';
    var stop = $('#scStop');
    if (stop) stop.disabled = !!S.canceling || !!(S.progress && S.progress.stopping);
    var cancel = $('#scCancel');
    if (cancel) cancel.disabled = !!S.canceling;
    /* .rs-btn 不用 disabled —— 用 400ms 的 pointer-events:none 防误触
     * （disabled 会让元素失焦，而提前结束态我们刚把焦点放在它上面） */
  }

  /* 所有 /api/board 请求的**唯一入口** —— 统一置 S.pending + 发请求序号。 */
  function req(fresh, hold) {
    var seq = ++S.reqSeq;
    S.pending = true; syncButtons();
    return fetchBoard(fresh, hold).then(function (j) {
      S.pending = false; syncButtons();
      return { j: j, seq: seq };
    }, function (e) {
      S.pending = false; syncButtons();
      throw e;
    });
  }
  /* 撤销 / 提前结束这类「不进 req() 的请求」也要作废在飞的老请求：
   * 否则 cancel 成功之后，一条还在飞的轮询回包会把状态改回 building（B3）。 */
  function bumpSeq() { S.reqSeq++; }

  function scModal() { return $('#scModal'); }
  /* 弹窗外要 inert 的兄弟节点（#viewScoring 自己是 .bd-body 的子元素，
   * 不能简单地 inert 整个 .bd-body —— 会把弹窗自己也 inert 掉）。 */
  function setInert(on) {
    var els = [$('.bd-hd'), $('#viewDeal'), $('#viewDetail'), $('#sys'), $('.bd-ft')];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      if ('inert' in HTMLElement.prototype) el.inert = !!on;
      else if (on) el.setAttribute('aria-hidden', 'true');
      else el.removeAttribute('aria-hidden');
    }
  }
  /* 旧榜各赛道张数快照（算 delta 用）。切榜期 / 新一轮时清。 */
  function countsOf(d) {
    if (!d || !d.boards) return null;
    var m = {};
    for (var i = 0; i < d.boards.length; i++) m[d.boards[i].id] = (d.boards[i].top || []).length;
    return m;
  }
  /* 102000 → 「1′42″」。ms 缺失时调用方整块隐藏，不留空占位符。 */
  function fmtDur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + '′' + pad2(s % 60) + '″';
  }

  /* ---------------- 取数 ---------------- */

  function setStatus(st, opt) {
    S.status = st;
    if (opt && opt.progress !== undefined) S.progress = opt.progress;
    if (opt && opt.err !== undefined) S.err = opt.err;
    /* ◆T22：确认条开着时状态被外部改成 building（另一标签页触发了本档评分）
     * ⇒ 立即收起 + 按钮 disabled。不抢焦点（用户可能正在操作别处）。 */
    if (st === 'building') cfClose(false);
    paintSys();
    /* 榜期卡第二行跟着状态走：building 的进度、none 的「尚未评分」、
     * failed 的「那次结果」都在这里刷 —— 以前只在 paint()（ready）刷，
     * 周榜 none 态就一直卡在「正在取数…」。 */
    paintRangeCard();
    /* 按钮禁用与状态同源 —— 这里统一刷一次（不再是 setTimeout(2500)） */
    syncButtons();
  }

  /* AI 配置的 localStorage 键刻意与 app.js 同一个（'juejin-boom:ai-cfg'）：
   * 同源页面共享 localStorage，所以「抽卡页里填过的配置」榜单页直接复用 ——
   * 扩展浮层里 board.html 与 host.html 是同源，用户在配置弹窗填一次就够，
   * 不必在榜单页再填一遍。站点版填了也走同一份（口径与 /api/roast 的传参一致）；
   * 没填就空着，由服务端 .ai-config.json / 环境变量兜底。 */
  var AI_CFG_KEY = 'juejin-boom:ai-cfg';
  function localAiCfg() {
    try {
      var c = JSON.parse(localStorage.getItem(AI_CFG_KEY) || 'null');
      /* 与 app.js 的 loadAiCfg() 同一条判据：有地址（或厂商）且有模型才算配好 */
      return (c && (c.baseUrl || c.providerId) && c.model) ? c : null;
    } catch (e) { return null; }
  }

  function fetchBoard(fresh, hold) {
    /* ?mock=1 = 用确定性假分数代替 AI（只做前端联调，不烧 token），
     * 服务端在 ?mock=1 / JB_BOARD_MOCK=1 时走假打分。
     * hold=1 = 只读现状、绝不触发评分（周榜不自动评，见 load）。
     * 带 AI 配置时改走 POST、把配置放请求体 —— token 不该出现在 URL 里。 */
    var url = 'api/board?range=' + S.range + (fresh ? '&fresh=1' : '') +
      (hold ? '&hold=1' : '') + (q.get('mock') === '1' ? '&mock=1' : '');
    var ai = localAiCfg();
    var init = { cache: 'no-store' };
    if (ai) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify({ ai: ai, hold: !!hold });
    }
    return fetch(url, init).then(function (r) { return r.json(); });
  }

  /* stop / cancel 两种「命令型请求」的公共取数：与 fetchBoard 同形（带 AI 配置走 POST），
   * 只是命令名不同。键名与 body 字段刻意与 fetchBoard 那套一致，
   * 服务端从 query 或 body 任一侧都能读到。 */
  function cmdBoard(query, bodyFlag) {
    /* ⚠️ query 必须是**写死的字面量**（&stop=1 / &cancel=1）——
     *   scripts/check_extension.py 有一条断言直接在源码里找 `&stop=1`，
     *   拼字符串会让它静默失效（「提前结束」按钮停不下来）。 */
    var url = 'api/board?range=' + S.range + query +
      (q.get('mock') === '1' ? '&mock=1' : '');
    var ai = localAiCfg();
    var init = { cache: 'no-store' };
    if (ai) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json' };
      var b = { ai: ai };
      b[bodyFlag] = true;
      init.body = JSON.stringify(b);
    }
    return fetch(url, init).then(function (r) { return r.json(); });
  }

  /* 提前结束（v1.3.1）：打断抓取/打分，以已读数据组榜。
   * 发完 stop 立刻按返回的快照刷一次 —— building → 「收尾中」继续轮询，
   * ready → 直接落定（mock 模式几乎瞬时）。
   * ◆v1.4：也置 S.pending 并 bumpSeq —— 连点 .sc-stop 会重复
   *   clearTimeout + fetch + load（引擎侧幂等，前端不该重复跑）。 */
  function stopBoard() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    bumpSeq();
    S.pending = true; syncButtons();
    cmdBoard('&stop=1', 'stop').then(function (j) {
      S.pending = false; syncButtons();
      if (j && j.status === 'building') {
        setStatus('building', { progress: j.progress });
        pollTimer = setTimeout(function () { load(false, true); }, 600);
        return;
      }
      if (j && (j.status === 'ready' || j.status === 'failed')) {
        if (j.status === 'failed') { setStatus('failed', { err: j.error || '生成失败' }); return; }
        finishReady(j);
      }
    }).catch(function () {
      S.pending = false; syncButtons();
      /* 停止失败就接着轮询原任务 */ load(false, true);
    });
  }

  /* ◆v1.4 撤销整轮（「取消本次评分」）—— 与 stop 的差别是**不落盘**：
   * 产物整轮作废、旧榜原地不动。
   *
   * ⚠️⚠️ **撤销是「协作式」的，不能"收包即关"**（引擎 §7-6 / ux §1.5）：
   *   `cancel()` 只做三件事就返回（置 cancelReq、打 progress.cancelling、abort 那一手），
   *   真正的收尾在 `cancelRestore()`，要等 run() 撞上下一道闸门（页间 / 空榜组榜前 /
   *   打分后 / 落盘前），**1~3 秒**。⇒ **cancel 的回包永远是 `building`**（含
   *   `progress.cancelling:true`），必须**继续轮询到落定**，收包即关会让弹窗
   *   消失、然后任务还在后台跑完落盘。
   *
   * ◆三条回包**一行都不许写 `S.data`**（ux 铁律）：
   *   ① 无旧 payload ⇒ `{status:'cancelled'}`（引擎给空壳 job，不是 delete）；
   *   ② 有旧 payload ⇒ `{status:'ready', payload:旧榜, cancelled:true}`，
   *      写了会把 generatedAt 被自己覆盖一遍 ⇒ 下一轮 delta 全算成 ±0；
   *   ③ 晚了一步已落盘 ⇒ 新榜，但那是**结果卡的活**，交给 finishReady() 写。
   *
   * ⚠️ 引擎的**双 l**：响应里是 `status:'cancelled'` / `j.cancelled`，
   *    前端 S.status 是 `canceled`（单 l，T13 定的）。别写串。 */
  function cancelBoard() {
    if (S.canceling) return;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    bumpSeq();                       // 作废在飞的轮询回包（B3）
    S.canceling = true;              // 第①层：点击当帧即进 busy（不等轮询）
    S.cancelPoll = 0;                // T16b 兜底用的轮询计数
    S.pending = true;
    syncButtons();
    paintScoring();
    paintRangeCard();                // .rng-cap 的撤销分支（灰、不加 is-building）
    cmdBoard('&cancel=1', 'cancel').then(function (j) {
      S.pending = false;
      syncButtons();
      /* 竞态（B3）：撤销在飞的时候 1.3s 轮询先拿到 ready、已经切了结果态
       * ⇒ 这条回包作废（不弹 toast、不改状态）。 */
      if (S.resultPhase) { clearCancelBusy(); paintScoring(); return; }
      routeCancel(j);
    }).catch(function () {
      /* T16（网络层失败）：弹窗绝不能冻死在「正在撤销…」
       * ⇒ S.canceling=false + **立即 paintScoring()**（否则 1.3s 里文案还在撒谎）
       *   + toast + 恢复轮询。 */
      S.pending = false;
      clearCancelBusy();
      paintScoring();
      paintRangeCard();
      toast('撤销没成功 · 这一轮还在跑');
      load(false, true);
    });
  }

  /* 撤销回包的落点路由。◆判据一律看 `j.cancelled`，**不看 status**：
   * 两条路的 status 不一样（无旧 payload ⇒ 'cancelled'；有旧 payload ⇒ 'ready'），
   * 只有 `cancelled:true` 是共同的 —— 只看 status 会把「有旧榜」误判成"跑完了"，
   * 撤销成功后弹出结果卡。 */
  function routeCancel(j) {
    var st = j && j.status;
    var landed = !!j && (st === 'cancelled' || j.cancelled === true || st === 'none');

    if (landed) {
      /* T12 / T13 / T14：撤销落定。**先停轮询**（无旧榜时日榜的下一次
       * ensure(fresh=false) 会回快照、不会自动重跑，但停掉更省心）。 */
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      clearCancelBusy();
      /* 撤销成功后 runId 会退回 null ⇒ 清掉 B1 的探测基线，
       * 别把「一侧是 null」当成「任务被换过」而弹重启 toast。 */
      S.lastRunId = null; S.lastScanned = 0; S.lastPages = 0; S.restartNotified = false;
      var hadOld = !!S.data;
      dismissScoring(function () {
        if (hadOld) {
          /* T12 有旧榜：弹窗收起、**不出结果卡**、旧榜原地不动。
           * ⚠️ 不写 S.data、不调 paint() —— 重绘会让扇形牌阵重播入场动画，
           *    视觉上「榜动了一下」，与「原地不动」矛盾（这是撤销的验收标准）。 */
          toast('已撤销 · 旧榜没动');
          setStatus('ready', { progress: null, err: null });
        } else if (S.range === 'day') {
          /* T13 日榜无旧榜：**必须**显示「已撤销」，绝不能显示 ready 空态 ——
           * 那等于说「评完了，0 张上榜」，是撒谎。 */
          toast('已撤销 · 这次没出榜');
          setStatus('canceled');
        } else {
          /* T14 周榜无旧榜：周榜「没评过」本来就是常态，回 none。 */
          toast('已撤销 · 这次没出榜');
          setStatus('none');
        }
        focusBtnFresh();
      });
      return;
    }

    if (st === 'ready') {
      /* T15 晚了一步（已落盘）：不抛错，照常走结果卡 + 一条 toast。
       * 只有这一支允许写 S.data —— 由 finishReady() 写（结果卡的活）。 */
      clearCancelBusy();
      toast('已经评完了，撤销不了');
      finishReady(j);
      return;
    }

    if (st === 'failed') {
      clearCancelBusy();
      setStatus('failed', { err: (j && j.error) || '生成失败' });
      return;
    }

    /* st === 'building'（含 progress.cancelling:true）⇒ 协作式收尾中，继续轮询。
     * ⚠️ 这里**不能**当成「撤销没生效」—— 那正是正常路径。 */
    S.progress = (j && j.progress) || S.progress;
    S.cancelPoll++;
    /* ◆T16b 兜底（团队 P0）：引擎若缺 idle/cancelled 分支，撤销后会永远回
     * `{status:'building', progress:null}` ⇒ 轮询永不终止 + 弹窗永久卡在
     * 「正在撤销本次评分」+ #btnFresh 永久 disabled。
     * 连续 6 拍（≈8s）没落定 ⇒ 按本地状态收场。 */
    if (S.cancelPoll > 6) {
      clearCancelBusy();
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      var had = !!S.data;
      dismissScoring(function () {
        toast(had ? '已撤销 · 旧榜没动' : '已撤销 · 这次没出榜');
        if (had) setStatus('ready', { progress: null, err: null });
        else if (S.range === 'day') setStatus('canceled');
        else setStatus('none');
        focusBtnFresh();
      });
      return;
    }
    paintScoring();
    paintRangeCard();
    pollTimer = setTimeout(function () { load(false, true); }, 1300);
  }

  /* 撤销 busy 态的复位：清本地意图 + 摘 .is-canceling + 按钮退回默认（**不 arm**）。
   * ⚠️ 三条落点（T12/T13/T14/T15/T16）都必须过这里，否则 .sc-cancel 会一直顶着
   *    「正在撤销…」的 spinner 到下一次打开弹窗。 */
  function clearCancelBusy() {
    S.canceling = false;
    disarmCancel();
    var m = scModal();
    if (m) m.classList.remove('is-canceling');
    syncButtons();
  }

  /* 撤销按钮的两段式（click-to-arm）：6 字等宽 ⇒ arm 时不回流。
   * 不做二次确认弹窗 —— 遮罩叠加 + Esc 双义 + 焦点陷阱（visual-spec §1.3）。 */
  function armCancel() {
    var b = $('#scCancel');
    if (!b || b.disabled) return;
    b.classList.add('is-arm');
    b.textContent = '再点一次撤销';
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(disarmCancel, 3500);
  }
  function disarmCancel() {
    var b = $('#scCancel');
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (!b || S.canceling) return;
    b.classList.remove('is-arm', 'is-busy');
    b.textContent = '取消本次评分';
  }
  function busyCancel() {
    var b = $('#scCancel');
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    if (!b) return;
    b.classList.remove('is-arm');
    b.classList.add('is-busy');
    b.textContent = '正在撤销…';
    /* ⚠️ 下一步 cancelBoard() 会把 #scCancel 置 disabled，而它此刻**持有焦点**
     * ⇒ disabled 会让焦点掉回 body，键盘用户在这一轮里就再也没有落点了。
     * 先把焦点收进弹窗容器（.sc-modal 有 tabindex="-1"），撤销结束后再决定去哪。 */
    var m = scModal();
    if (m) { try { m.focus(); } catch (e) {} }
  }

  var pollTimer = null;

  function load(fresh, isPoll) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    /* ⭐ 新一轮打分（首屏 / 切榜期 / 点重新评分）要把发牌台清空。
     * 判据是**这次不是轮询续期** —— 轮询必须保留 scSeen，
     * 否则每 1.3s 清一次，六摞会反复归零。
     * （同一批沸点重新算时 pinId 是重复的，不清就会被去重吃掉。） */
    if (!isPoll) scReset();
    /* ⭐ v1.3.1 周榜**绝不自动评**：非用户主动（fresh）的周榜请求一律 hold
     *   只读现状 —— 没算过就拿到 status='none'，亮「开始评分」按钮；
     *   日榜保持「进门自动评」。轮询也走 hold：就算 dev server 重启丢了任务，
     *   也只会回落到「开始评分」屏，而不是偷偷替用户开一轮 45 页扫描。 */
    var hold = !fresh && S.range === 'week';
    /* ⚠️ 只有「首拉探测」（还不知道是 building 还是 none）才用 loading 过渡态；
     *    轮询必须保持 building —— paintSys 是按状态切视图的，
     *    loading↔building 每 1.3s 切一次 = 发牌视图整屏一闪一闪（实测反馈）。
     *
     * ◆v1.4 把判据从 `(hold && !isPoll)` 收紧成 `!isPoll`：
     *    日榜首拉（hold=false）原来直接进 building ⇒ paintSys 会**先把发牌弹窗打开**，
     *    缓存命中时那一拍就拿到 ready ⇒ 弹窗闪一下、并且 **finishReady 判定
     *    「弹窗本来开着」⇒ 每次打开页面都弹一张结果卡**（T4 明确要求首拉 ready 不出卡）。
     *    改成先 loading（弹窗不打开）⇒ 缓存命中 = 静默拿到榜单；真要重建 =
     *    回包是 building，弹窗这时才开，用户感知完全一致。 */
    setStatus(isPoll ? 'building' : 'loading', { progress: S.progress, err: null });
    req(fresh, hold).then(function (r) {
      var j = r.j;
      /* 竞态闸门（B3）：有更新的请求发出去了（切榜期 / 撤销 / 提前结束 / 新一轮）
       * ⇒ 这条回包作废。漏了它，撤销成功后一条在飞的轮询会把状态改回 building。
       * ⚠️ 轮询自己也算在内：cancelBoard / stopBoard 会 bumpSeq 主动作废在飞的轮询。 */
      if (r.seq !== S.reqSeq) return;
      /* 撤销进行中 ⇒ 这一拍归撤销路由管（落点判定看 j.cancelled，不看 status）。
       * 走普通分支会把「有旧榜的撤销回包」误判成"跑完了"而弹出结果卡。 */
      if (S.canceling) { routeCancel(j); return; }
      if (j && j.status === 'none') {
        /* 周榜还没评过：不烧 token，把决定权交给按钮 */
        setStatus('none');
        return;
      }
      if (j && j.status === 'building') {
        S.data = j.boards && j.boards.length ? j : S.data;
        detectRestart(j.progress);
        setStatus('building', { progress: j.progress });
        /* 「评分中」要能看见进度，所以轮询 —— 一次全量抓取 + 打分要一两分钟，
         * 界面必须让人知道它在动，而不是死了。 */
        pollTimer = setTimeout(function () { load(false, true); }, 1300);
        return;
      }
      if (j && j.status === 'failed') {
        /* ⚠️ 既有缺陷（B13 / ux-spec §7-4，本次一并修）：旧判据带
         *    `&& !(j.boards && j.boards.length)` ⇒ 「重算失败但旧榜还在」会被
         *    **静默吞掉**，界面假装成功（旧榜 + 正常规模行），用户不知道刚那轮挂了。
         *    改：有旧榜时仍然 setStatus('failed')，但**保留 S.data**
         *    （j 里带的正是旧 payload），再给一条 toast 说清。 */
        var hasOld = !!(j.boards && j.boards.length);
        if (hasOld) S.data = j;
        setStatus('failed', { err: j.error || '生成失败' });
        if (hasOld) toast('这轮没算出来 · 下面还是上次的结果');
        return;
      }
      if (j && j.status === 'ready') { finishReady(j); return; }
      /* 未知形状：当失败处理。**绝不**假装成功 —— 用户会盯着一份其实是旧的数据，
       * 以为刚刚那两分钟算出了结果。 */
      setStatus('failed', { err: (j && j.error) || '接口返回异常' });
    }).catch(function (e) {
      /* 撤销轮询掉线 ⇒ 按 T16 处理（不能让弹窗冻死在「正在撤销…」） */
      if (S.canceling) {
        clearCancelBusy();
        paintScoring();
        paintRangeCard();
        toast('撤销没成功 · 这一轮还在跑');
        load(false, true);
        return;
      }
      /* 轮询掉线不该整页变失败 —— 下一拍可能就好了（dev server 重启那几秒尤其常见）。
       * ⚠️ 但要**有界**：连续 3 拍都失败才落 failed，否则一次网络抖动就会
       * 把跑到一半的发牌弹窗整个换成失败卡（那才是真的谎）。 */
      if (isPoll) {
        S.pollErr++;
        if (S.pollErr <= 3) {
          pollTimer = setTimeout(function () { load(false, true); }, 1300);
          return;
        }
      }
      setStatus('failed', { err: String((e && e.message) || e) });
    });
  }

  /* ◆B1 进程重启探测：dev server 重启 / 扩展 SW 被回收 ⇒ 任务丢了，
   * 日榜 ensure() 会起一个全新任务（从头再扫一遍）。
   *   · 根治（引擎加 runId，§7-1）：比对 progress.runId，变了就是新的一轮；
   *   · 兜底（runId 还没落地）：本帧 scanned < 上帧 × 0.5 且 pages 变小。
   * ⚠️ 周榜静默不 toast —— 周榜 hold 本来就可能 none，不是异常。
   * ⚠️ 一条轮次只报一次（S.restartNotified）。 */
  function detectRestart(p) {
    /* 撤销期间一律不探测：撤销落定前 progress 可能是 null（引擎缺 idle 分支那一帧），
     * 走启发式会被误判成「进程重启」而弹一条假 toast。 */
    if (S.range !== 'day' || S.canceling) return;
    p = p || {};
    var restarted = false;
    if (p.runId && S.lastRunId && p.runId !== S.lastRunId) restarted = true;
    else if (!p.runId && S.lastScanned > 0 &&
             (p.scanned || 0) < S.lastScanned * 0.5 && (p.pages || 0) < S.lastPages) {
      restarted = true;
    }
    if (restarted && !S.restartNotified) {
      S.restartNotified = true;
      toast('评分进程重启了，这一轮从头开始');
    }
    S.lastRunId = p.runId || null;
    S.lastScanned = p.scanned || 0;
    S.lastPages = p.pages || 0;
  }

  /* 落定（building → ready）。◆v1.4：结果卡在这一步切，三件事的顺序是硬约束：
   *   ① 先快照 S.progSnap = S.progress —— setStatus('ready') 会把它清成 null，
   *      而结果卡的百分比条要的就是「最后一帧」；
   *   ② 再量 modal.offsetHeight 写进 style.height —— paintSys 一跑到 ready 就会
   *      showScoring(false)（hidden 元素量出来是 0），必须抢在它之前；
   *   ③ 只有「弹窗本来开着」（用户真的看着这一轮跑完）才出结果卡 ——
   *      缓存命中的首拉（loading → ready 一拍到位）没有可汇报的东西。 */
  function finishReady(j) {
    var modal = scModal();
    var v = $('#viewScoring');
    var wasScoring = !!(v && !v.hidden);
    /* ⚠️ 用 getComputedStyle().height，不用 offsetHeight：
     *    offsetHeight 是**取整**的（实测 574.6 → 575），把它写回 style.height
     *    会让弹窗比原来高 0.4px ⇒ 切换瞬间纵向抖 1px，「外框一像素不动」当场不成立。
     *    computed 的 height 是带小数的**使用值**，原样写回就是零漂移。 */
    var h = 0;
    if (wasScoring && modal) h = parseFloat(getComputedStyle(modal).height) || 0;
    S.data = (j && j.boards && j.boards.length) ? j : (S.data || j);
    S.progSnap = S.progress || null;
    if (wasScoring) {
      S.resultPhase = resultPhaseOf();
      if (h) modal.style.height = h + 'px';   // 冻结：结果态 hug 更矮，不冻就往上跳 90~185px
    }
    setStatus('ready', { progress: null, err: null });
    paint();
    if (S.resultPhase) showResult();
  }

  /* ◆「缺口」判定（ux-spec §2.5.1，照抄）—— 回答的是「这份榜**缺在哪**」。
   *
   * ⚠️ 结果态**不能只看 `S.data.stopped`**：stopped 只是引擎的一个布尔标记
   *    （board-core 在抓取之后就固定了），它不告诉界面产物缺在哪。
   *    只用它会撞出两格自相矛盾：
   *      ① stopped=true 但 done >= candidates（stopReq 在最后一手之后才置起）
   *         ⇒ 产物一点没少，却渲染成「榜不完整 + 进度条 100%」；
   *      ② 刷新过 / 轮询错过最后一帧 ⇒ 没有 progSnap，却硬说「后面还有沸点没读到」。
   * 判据用 `done >= candidates` 而不是 `done > 0`：后者在 done===0 时走 'score' 分支，
   * 而 score 阶段的 progSnap 没有 pages ⇒ 「扫描在第 N 页中断」会渲染成 undefined。 */
  function gapOf() {
    if (!S.data || !S.data.stopped) return 'none';   // 没停过 = 完成
    var p = S.progSnap;
    if (!p) return 'unknown';                        // 没有最后一帧进度
    if (p.phase === 'score' && p.candidates > 0) {
      return (p.done >= p.candidates) ? 'none' : 'score';
    }
    if (p.phase === 'scan') return 'scan';
    return 'unknown';                                // score 阶段但 candidates === 0，判不出来
  }

  /* 结果卡子态（team-lead v2 拍板，三态）：
   *   'done'    有牌        → 绿勾 + 评分完成 + 3.2s 自动关
   *   'empty'   0 张        → 绿勾 + 评分完成 + **常驻手动关**（不用琥珀：空榜是
   *                          「完整但 0 张」，不是「不完整」；只有提前结束才用琥珀）
   *   'stopped' 提前结束    → 琥珀 + 提前结束 · 榜不完整 + 常驻手动关
   * ◆gap === 'none'（stopped 但产物完整）⇒ 归完成态，不许说「不完整」。 */
  function resultPhaseOf() {
    if (S.data && S.data.stopped && gapOf() !== 'none') return 'stopped';
    return totalCards() === 0 ? 'empty' : 'done';
  }

  /* ---------------- 渲染：评分中发牌（v0.8.0） ----------------
   *
   * ⭐ 数据源是 `progress.dealt`（board-core 的 scoreCandidates 每批回报的
   *   「本块每条分到哪个赛道」）。**必须累积，不能只留最新一批** ——
   *   前端 1.3s 轮询而 AI 一批十几秒，不累积的话中途发出的牌会凭空消失。
   *
   * ⚠️ 三种内容不能混为一谈（与榜期卡同一个原则，spec §6.7）：
   *   ranked=true  → 飞进对应赛道摞
   *   ranked=false → 「不够 6 分不上榜」，**不是失败**（榜单宁可空着）
   *   没拿到 dealt → 还在请求中
   */
  var scSeen = {};        // pinId -> 记录，防重（轮询会重复推同一批）
  var scCols = null;      // 六个 .sc-col 元素缓存
  /* 牌堆错开的格数上限：超过这个数就不再往下挪（否则压到赛道名，见 paintScoring）。
   * ⚠️ 必须与 board.css 的 `--sc-fan` 一致（.sc-pile 靠它预留错开高度）。 */
  var SC_FAN_MAX = 6;

  /* 新一轮打分 = 推倒重来。⚠️ 只在「不是轮询续期」时调（见 load）：
   * 同一批沸点重算时 pinId 会重复，去重表不清就会把新发的牌全吃掉。
   * ◆v1.4：顺带清掉 B1 的进程重启探测基线 —— 「新一轮」就是新的基线。 */
  function scReset() {
    scSeen = {};
    S.lastRunId = null; S.lastScanned = 0; S.lastPages = 0; S.restartNotified = false;
    S.pollErr = 0;
  }

  /* 赛道色的 8% 淡底 —— 给「顶牌」和计数徽标用。
   * 用 color-mix 而不是硬编码六组浅色：赛道色一改这里自动跟着走。 */
  function tintOf(hex) {
    return 'color-mix(in srgb, ' + hex + ' 8%, #fff)';
  }

  function scBuckets() {
    var b = {};
    for (var i = 0; i < TRACKS.length; i++) b[TRACKS[i].id] = [];
    return b;
  }

  function paintScoring() {
    var p = S.progress || {};
    /* ⚠️◆撤销段必须是**第一句**，且是「先写三行文案再 return」，不能裸 return ——
     * 这三行正是本函数自己写的，裸 return 会把撤销文案一起吞掉，弹窗只剩上一帧的
     * 「正在落位 → xx 榜」（visual-spec v4 写错过，v5 已更正）。
     * ★ 这样写还顺带免疫「引擎缺 idle 分支」那个 P0 的视觉副作用：撤销落定后回包是
     *   `{status:'building', progress:null}`，照常重绘会渲染出「六摞计数全 0 +
     *   正在读取沸点流…第 1 页」。提前 return ⇒ 这一帧根本不画。
     * 六摞 / 牌堆 / 阶段条 / #scHallS 一律不碰 —— 数据还在，只是不再落盘。
     *
     * 判据 = `S.canceling ‖ p.cancelling`（v4 三层论的第①层与第②层）：
     *   S.canceling 在**点击那一帧**就位，p.cancelling 是服务端已受理的确认
     *   （刷新页面后只有后者还在）。 */
    if (S.canceling || p.cancelling) {
      var t0 = $('#scTitle'), h0 = $('#scHallT'), n0 = $('#scHallNow');
      if (t0) t0.textContent = '正在撤销本次评分';   // 标题：第一语义锚点
      if (h0) h0.textContent = '旧榜不会被改动';     // 副题：说**结果**
      if (n0) { n0.textContent = '正在撤销 · 本轮作废'; n0.style.color = ''; }
      var mm = scModal();
      if (mm) mm.classList.add('is-canceling');     // 点击当帧即进 busy（不等轮询）
      return;
    }
    var dealt = p.dealt || [];
    var b = scBuckets();
    var lost = 0, n = 0;
    /* 最后一张落进哪一摞（给发牌台的「正在落位」提示用） */
    var lastTop = null;
    /* ⚠️ 六摞必须按**全量 dealt 历史**重建（progress.dealt 引擎侧已累积）。
     *   曾经在这里按 scSeen 跳过旧牌 —— 结果每次轮询重绘时摞里只剩
     *   「最新一手」，之前发出去的牌凭空消失，发牌动画完全看不出累积。
     *   scSeen 现在只干一件事：标记「这张牌是不是这屏第一次出现」，
     *   首次出现的挂 .is-new（入场动画只播给它），重绘的旧牌静态落位。 */
    for (var i = 0; i < dealt.length; i++) {
      var d = dealt[i];
      n++;
      if (d.ranked && d.trackId && b[d.trackId]) b[d.trackId].push(d);
      else if (!d.ranked) lost++;
    }

    /* 阶段条：第 1、2 步在进入打分阶段后才有确定的数字 */
    var scan = $('#scScan'), cand = $('#scCand'), done = $('#scDone');
    if (scan) scan.textContent = p.scanned || 0;
    if (cand) cand.textContent = p.candidates || 0;
    if (done) done.textContent = (p.done || 0) + '/' + (p.candidates || 0);
    /* 扫描阶段（还没进打分）：第 1 步在动、第 2、3 步别提前打勾 */
    var scoring = p.phase === 'score';
    var stepEls = document.querySelectorAll('#scPhase .sc-step');
    for (var k = 0; k < stepEls.length; k++) {
      stepEls[k].classList.toggle('is-now', scoring ? k === 2 : k === 0);
      stepEls[k].classList.toggle('is-done', scoring ? k < 2 : false);
    }

    /* 六摞 */
    if (!scCols) {
      var deck = $('#scDeck');
      if (!deck) return;
      deck.innerHTML = TRACKS.map(function (t) {
        return '<div class="sc-col" data-track="' + t.id + '"' +
          ' style="--sc-color:' + t.color + ';--sc-tint:' + tintOf(t.color) + '">' +
          '<div class="sc-pile" data-pile="' + t.id + '"></div>' +
          '<div class="sc-meta"><span class="sc-name">' + t.name + '</span>' +
          '<span class="sc-num" data-num="' + t.id + '">0</span></div></div>';
      }).join('');
      scCols = {};
      var cols = deck.querySelectorAll('.sc-col');
      for (var c = 0; c < cols.length; c++) scCols[cols[c].getAttribute('data-track')] = cols[c];
    }

    for (var ti = 0; ti < TRACKS.length; ti++) {
      var t = TRACKS[ti];
      var col = scCols[t.id];
      if (!col) continue;
      var list = b[t.id];
      var pile = col.querySelector('[data-pile]');
      var num = col.querySelector('[data-num]');
      if (num) num.textContent = list.length;
      if (!pile) continue;

      if (!list.length) {
        pile.className = 'sc-pile is-empty';
        pile.textContent = '等 AI 发牌';
        continue;
      }
      pile.className = 'sc-pile';
      /* ⭐ 一摞牌**倒着叠**：第 1 名在最上（--i:0），往后每张往下 4px。
   *   这样两件事同时成立：
   *     - 视觉上「越靠下名次越大」，符合牌堆直觉
   *     - 新发的那张永远在**最下面**，也就是「刚落进这一摞」的那张
   *       （is-top 给它赛道色 —— 用户第一眼看到的就是刚发生的事）
   * ⚠️ 错开量在**这里封顶**（SC_FAN_MAX）：.sc-pile 固定高、不裁剪，
   *    12 张全按 4px 挪会多出 44px，最后一张压到赛道名上（实测 5~6 张就压）。
   *    CSS 里不做 min(var(--i),N) —— min() in calc() 兼容性不稳。
   *    封顶后超过的那些张会**完全重叠**，只靠最下面那张露出来表示「还有更多」。 */
      var h = '';
      for (var m = 0; m < list.length; m++) {
        var x = list[m];
        var last = (m === list.length - 1);
        /* is-new = 这屏第一次出现的牌（入场动画只挂它，见 CSS）；
         * 轮询重绘的旧牌不带 → 静态落位，不再整摞重播动画。 */
        var fresh0 = !scSeen[x.pinId];
        h += '<div class="sc-card' + (last ? ' is-top' : '') + (fresh0 ? ' is-new' : '') + '"' +
          ' style="--i:' + Math.min(m, SC_FAN_MAX) + '" title="' + esc(x.title || '') + '">' +
          '<div class="sc-top">' +
            '<b class="sc-rank">' + pad2(m + 1) + '</b>' +
            '<span class="sc-sym">' + sym(t.id, 15) + '</span>' +
          '</div>' +
          '<div class="sc-head">' + x.score + ' · ' + esc(t.def) + '</div>' +
          '<div class="sc-mid"><span class="sc-sym">' + sym(t.id, 34) + '</span></div>' +
          '<div class="sc-verdict">' + esc(x.verdict || x.title || '') + '</div>' +
          '</div>';
      }
      pile.innerHTML = h;
      /* 记下「最后落到哪一摞的」——发牌台上那行提示要用。 */
      if (m) lastTop = { t: t, n: list.length };
    }
    /* 全量重绘完再把这批牌记入 scSeen —— 下一次轮询它们就不带 .is-new 了 */
    for (var si = 0; si < dealt.length; si++) scSeen[dealt[si].pinId] = 1;

    /* ⭐ v1.3.3 飞行向量：新牌的入场动画起点 = 左侧牌堆中心 → 这张牌的落位。
     *   按实测矩形算（弹窗刚打开时元素还没尺寸，rect 为 0 就跳过这次向量，
     *   下一轮轮询补上）。is-new 一批可能有多张，全都从堆顶飞向各自堆位。 */
    var deckEl = $('#scHand');
    var news = $('#scDeck').querySelectorAll('.sc-card.is-new');
    if (deckEl && news.length && news.length <= 8) {
      var dr = deckEl.getBoundingClientRect();
      if (dr.width) {
        var dcx = dr.left + dr.width / 2, dcy = dr.top + dr.height / 2;
        for (var fj = 0; fj < news.length; fj++) {
          var fr = news[fj].getBoundingClientRect();
          if (!fr.width) continue;
          news[fj].style.setProperty('--flydx', Math.round(dcx - (fr.left + fr.width / 2)) + 'px');
          news[fj].style.setProperty('--flydy', Math.round(dcy - (fr.top + fr.height / 2)) + 'px');
        }
      }
    }

    /* 弹窗头 + 左侧牌堆：待发 = 候选总数 − 已打分；扫描期 = 已读页数 */
    var total = p.candidates || 0, scored = p.done || 0;
    var left = Math.max(0, total - scored);
    var hallT = $('#scHallT'), hallS = $('#scHallS'), hallNow = $('#scHallNow'), hand = $('#scHand');
    var scTitle = $('#scTitle');
    if (scTitle) {
      scTitle.textContent = p.stopping ? '正在收尾' : (scoring ? 'AI 正在分赛道' : '正在读取数据');
    }
    /* ⭐ v1.3.1 进度三问全在这两行：「读了多少」= hallS 的已扫 N 条；
     *    「正在分析什么」= p.now（引擎在每一手**开打之前**报上来的标题清单）；
     *    「处理了多少」= scDone 的 done/total。 */
    if (hallNow) {
      if (p.stopping) {
        hallNow.textContent = '已请求结束 —— 正在用已读数据收尾…';
        hallNow.style.color = '';
      } else if (p.now && p.now.length && scoring) {
        hallNow.textContent = '正在分析：「' + p.now[0] + '」等 ' + p.now.length + ' 条';
        hallNow.style.color = '';
      } else if (lastTop) {
        hallNow.textContent = '正在落位 → ' + lastTop.t.name + ' 第 ' + lastTop.n + ' 张（' + lastTop.t.def + '）';
        hallNow.style.color = lastTop.t.color;
      } else if (scoring) {
        hallNow.textContent = 'AI 正在给这一手分赛道…';
        hallNow.style.color = '';
      } else {
        hallNow.textContent = '正在读取沸点流…';
        hallNow.style.color = '';
      }
    }
    if (hallT) {
      hallT.textContent = p.stopping
        ? '正在收尾（不再抓新数据）'
        : scoring
          ? (left > 0 ? ('第 ' + (scored + 1) + ' 条待发') : '这一手发完了')
          : ('正在翻沸点流…第 ' + (p.pages || 1) + ' 页');
    }
    if (hallS) {
      hallS.textContent = scoring
        ? ('已有 ' + (n - lost) + ' 条归榜 · ' + lost + ' 条不够 6 分不上榜')
        : ('已扫 ' + (p.scanned || 0) + ' 条 · 抓完才开始打分');
    }
    /* 左堆厚度：分析期 = 待发的牌（每发一手薄一层，发完空堆）；
     * 扫描期 = 已读的页数（越扫越厚）。堆顶那张亮蓝边 = 下一手从这里飞出去。 */
    if (hand) {
      var thick = scoring ? Math.ceil(left / 5) : (p.pages || 0);
      var show = Math.min(6, thick);
      var hh = '';
      for (var q = show - 1; q >= 0; q--) {
        hh += '<i class="' + (scoring && q === 0 ? 'is-going' : '') + '" style="--i:' + q + '"></i>';
      }
      hand.innerHTML = hh;
      var fmCount = $('#fmCount');
      if (fmCount) fmCount.textContent = scoring ? ('待发 ' + left) : ('已读 ' + (p.scanned || 0) + ' 条');
    }
  }

  /* 切到发牌弹窗 / 收起。⚠️ v1.3.3 起是**弹窗**（遮罩自己压暗页面）：
   * 后面的 viewDeal / viewDetail 不用藏 —— 有旧榜时它们留在遮罩下当背景，
   * 首评时后面是空壳也无妨。
   *
   * ◆v1.4 补两件既有缺陷：
   *   ① **焦点**：原来 showScoring() 完全不做焦点管理，弹窗开了焦点还在
   *      #btnFresh 上（而且在弹窗**外面**）⇒ 键盘用户 Tab 会跑出弹窗。
   *      现在：开 = 焦点进 .sc-modal（tabindex="-1"）；关 = 回 #btnFresh。
   *      ⚠️ 只在「从隐藏变可见」时抢焦点 —— 轮询每 1.3s 都会调一次 showScoring(true)，
   *      每次都 focus 会把用户正在操作的元素抢走。
   *   ② **焦点陷阱**：弹窗外的内容加 inert（.bd-hd / #viewDeal / #viewDetail /
   *      #sys / .bd-ft）。本轮 0 张时 .sys 空榜卡与结果卡同时存在，
   *      不 inert 的话读屏会在结果卡之外再读一张「暂无上榜」。 */
  function showScoring(on) {
    var v = $('#viewScoring');
    if (!v) return;
    if (on) {
      var wasHidden = v.hidden;
      v.hidden = false;
      paintScoring();
      if (wasHidden) {
        setInert(true);
        var m = scModal();
        if (m) m.focus();
      }
    } else {
      v.hidden = true;
      setInert(false);
      var m2 = scModal();
      if (m2) m2.style.height = '';      // 冻结高度的兜底清理
    }
  }

  /* 带收起动画地关掉弹窗（撤销成功 / 结果卡关闭都走这里）。
   * 减动效档直接 hidden —— **时长不变**（减动效只减动效，不改信息停留时间）。 */
  function dismissScoring(after) {
    var v = $('#viewScoring'), modal = scModal();
    if (!v || v.hidden) { if (after) after(); return; }
    if (!modal || !motion()) { showScoring(false); if (after) after(); return; }
    modal.classList.add('is-out');
    var done = false;
    var fin = function () {
      if (done) return;
      done = true;
      modal.classList.remove('is-out');
      showScoring(false);
      if (after) after();
    };
    /* ⚠️ animationend 会**冒泡**：六摞牌的 scDeal / spinner 的 cfSpin 结束也会触发它。
     * 只认来自 modal 自己那一帧动画的。 */
    var onEnd = function (e) { if (e.target === modal) fin(); };
    modal.addEventListener('animationend', onEnd, { once: true });
    /* 兜底：animationend 不触发（元素被提前隐藏 / 动画被打断）时也要收干净 */
    setTimeout(fin, 420);
  }

  /* ================= ③ 结果卡 =================
   * 同一个 .sc-modal 里的内容切换（不另开一张卡 —— 又一次弹出动画 + 新遮罩层级，
   * 用户会读成「又来一个弹窗」）。高度已由 finishReady() 冻结，这里只填内容。 */
  var RS_ICO_OK = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none">' +
    '<path d="M3.6 9.4l3.4 3.4L14.4 5" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var RS_ICO_WARN = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none">' +
    '<path d="M9 3.4v7.4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '<circle cx="9" cy="14.1" r="1.2" fill="currentColor"/></svg>';

  function showResult() {
    var modal = scModal(), res = $('#scResult');
    if (!modal || !res) return;
    modal.classList.add('is-result');
    res.hidden = false;
    /* 出现 400ms 内按钮不可点：用户刚点过「提前结束」，手指还在那个位置 ——
     * 按钮落在原位会被连点穿透，直接把结果卡关掉。 */
    res.classList.add('is-fresh');
    setTimeout(function () { res.classList.remove('is-fresh'); }, 400);
    /* ⭐ live region 的可靠性依赖「区域先存在且可见 → 再注入内容」：
     * 顺序反了读屏可能整块不播（ux-spec §3.3）。所以内容在**下一帧**写。
     * ⚠️ rAF 在后台标签页不触发 ⇒ 兜一个 300ms 的 timeout，
     *    否则切回标签页会看到一张空的结果卡（且永远不会自动关）。 */
    rsFilled = false;
    var fill = function () {
      if (rsFilled) return;
      rsFilled = true;
      fillResult();
      rsPaused = false;
      armAutoClose();
    };
    requestAnimationFrame(fill);
    setTimeout(fill, 300);
  }

  function fillResult() {
    var res = $('#scResult');
    if (!res || !S.data) return;
    var phase = S.resultPhase || 'done';
    var stopped = phase === 'stopped';
    var snap = S.progSnap;

    var ico = $('#rsIco');
    if (ico) {
      ico.innerHTML = stopped ? RS_ICO_WARN : RS_ICO_OK;
      ico.classList.toggle('is-stopped', stopped);
    }
    /* 0 张**仍走完成态**（绿勾 + 「评分完成」）—— 「不够 6 分不上榜」是中性事实，
     * 不是失败；用琥珀会把「数据事实」读成「异常」。
     * 三格共用的一套 `.rs-ico`：只有 stopped 挂 `is-stopped`（琥珀），
     * empty 与 done 都是绿勾。 */
    var title = $('#rsTitle');
    if (title) title.textContent = stopped ? '提前结束 · 榜不完整' : '评分完成';

    /* 用时：ms 缺失 ⇒ 整块隐藏，不留空占位符（B16） */
    var time = $('#rsTime');
    if (time) {
      var ms = S.data.ms;
      if (typeof ms === 'number' && ms > 0) {
        time.hidden = false;
        time.textContent = '用时 ' + fmtDur(ms);
        time.setAttribute('aria-label', '用时 ' + Math.floor(ms / 60000) + ' 分 ' +
          Math.round((ms % 60000) / 1000) + ' 秒');
      } else {
        time.hidden = true;
        time.textContent = '';
        time.removeAttribute('aria-label');
      }
    }

    /* 规模一行：扫描 → 候选 → 上榜。
     * ⚠️ candidates === 0（还没筛）时**省掉「候选」** —— 写出来会读成
     * 「没有候选」，而实际是「还没筛」。 */
    var scanned = S.data.scanned || 0;
    var cands = S.data.candidates;
    var total = totalCards();
    var scale = $('#rsScale');
    if (scale) {
      var txt = '扫描 <b class="num">' + scanned + '</b> 条';
      if (cands) txt += ' → 候选 <b class="num">' + cands + '</b> 条';
      txt += ' → 上榜 <b class="num">' + total + '</b> 张';
      scale.innerHTML = txt;
      scale.setAttribute('aria-label', '扫描 ' + scanned + ' 条，' +
        (cands ? '筛出候选 ' + cands + ' 条，' : '') + '上榜 ' + total + ' 张');
    }

    /* 琥珀横幅：**只有提前结束**显示。三版分叉的是「**缺在哪**」，不是「断在哪」——
     * 扫描截断与打分截断的**后果完全不同**（前者「后面还有内容没进来」、
     * 后者「内容都在，只是有一部分没被打分」），「后面还有沸点没读到」放在
     * score 那格是**假话**。
     * ⚠️ 三版都 ≤24 字 ⇒ 单行不折行 ⇒ 三格卡片高度一致（视觉规范 §5.2 排版约束）。 */
    var gap = gapOf();
    var note = $('#rsNote');
    if (note) {
      note.hidden = !stopped;
      note.textContent = !stopped ? ''
        : gap === 'scan' ? '提前结束 —— 这份榜只覆盖前半程，后面还有沸点没读到'
        : gap === 'score' ? '提前结束 —— 沸点都读完了，AI 只打分到一半就停了'
        : '提前结束 —— 这份榜不完整，已读到的那部分才参与排名';
    }

    /* 中断进度：跟着 `gap` 走（B15），三种形态：
     *   ① gap='score'（有分母）→ bar + txt；
     *   ② gap='scan'（没分母）→ **`.is-txtonly` 只留 txt、不画条**（画了是假信息）；
     *   ③ gap='unknown'（无 progSnap）→ **整块隐藏**，不显示 0%、不留占位符。 */
    var pct = $('#rsPct'), pctTxt = $('#rsPctTxt'), pctIn = $('#rsPctIn');
    if (pct && pctTxt && pctIn) {
      if (gap === 'score' && snap) {
        var done = snap.done || 0;
        var per = Math.max(0, Math.min(100, Math.round(done / snap.candidates * 100)));
        pct.hidden = false;
        pct.classList.remove('is-txtonly');
        pctIn.style.setProperty('--cf-pct', per + '%');
        pctTxt.textContent = 'AI 只打完 ' + done + '/' + snap.candidates + ' 条 · ' + per + '%';
        pctTxt.setAttribute('aria-label',
          'AI 只打完 ' + snap.candidates + ' 条里的 ' + done + ' 条，完成 ' + per + '%');
      } else if (gap === 'scan' && snap) {
        pct.hidden = false;
        pct.classList.add('is-txtonly');
        pctTxt.textContent = '扫描在第 ' + (snap.pages || 1) + ' 页中断 · 已扫 ' +
          (snap.scanned || 0) + ' 条';
        pctTxt.setAttribute('aria-label',
          '扫描在第 ' + (snap.pages || 1) + ' 页中断，已扫 ' + (snap.scanned || 0) + ' 条');
      } else {
        pct.hidden = true;
        pct.classList.remove('is-txtonly');
        pctTxt.textContent = '';
        pctTxt.removeAttribute('aria-label');
      }
    }

    /* 六赛道 chip：顺序**固定按 TRACKS**，不按张数排序 ——
     * 排序会让 chip 位置在每次重评后跳动，用户找不到上次看过的那个。 */
    var host = $('#rsTracks');
    if (host) {
      var prev = S.prevCounts;
      var emptyAll = total === 0;
      var h = '';
      for (var i = 0; i < TRACKS.length; i++) {
        var t = TRACKS[i];
        var b = null, bs = (S.data && S.data.boards) || [];
        for (var k = 0; k < bs.length; k++) if (bs[k].id === t.id) { b = bs[k]; break; }
        var n = b ? (b.top || []).length : 0;
        var d = '', aria = t.name + ' ' + n + ' 张';
        if (prev && prev[t.id] !== undefined) {
          var old = prev[t.id];
          var diff = n - old;
          /* ⚠️ 本轮 0 张 + 上次 > 0 ⇒ **不显示增减符号**：「−5」会被读成退步，
           * 而实际上只是这一轮没人过线；「0 → 0」是持平，照常给 ±0。 */
          if (!(emptyAll && diff < 0)) {
            if (diff > 0) { d = '+' + diff; aria += '，比上次多 ' + diff + ' 张'; }
            else if (diff < 0) { d = '−' + Math.abs(diff); aria += '，比上次少 ' + Math.abs(diff) + ' 张'; }
            else if (old === 0 && n > 0) { d = '新'; aria += '，上次是空的'; }
            else { d = '±0'; aria += '，与上次相同'; }
          }
        }
        h += '<span class="rs-tr" style="--sc-color:' + t.color + ';--sc-tint:' + tintOf(t.color) +
          '" aria-label="' + esc(aria) + '">' + esc(t.name) + ' <b class="num">' + n + '</b>' +
          (d ? '<b class="rs-delta">' + d + '</b>' : '') + '</span>';
      }
      host.innerHTML = h;
    }

    /* 按钮：有牌 → 「查看榜单」（下面真有榜）；0 张 / 提前结束 → 「知道了」
     * （下面没榜可看，「查看榜单」是句假话）。 */
    var btn = $('#rsBtn');
    if (btn) btn.textContent = phase === 'done' ? '查看榜单' : '知道了';

    /* 焦点：完成 · 有牌 ⇒ **不主动 focus 到按钮**（focusin 会暂停自动关闭 ⇒
     * 等于永不自动关）；另两个子态是常驻手动，按钮是唯一出口，键盘必须一键可达。 */
    if (phase !== 'done' && btn) {
      try { btn.focus(); } catch (e) { /* 弹窗刚出现时可能还不可聚焦 */ }
    }
  }

  /* 自动关闭：**只有「完成 · 有牌」** 才设 3.2s。
   * 「今天确实没东西上榜」与「这份榜不完整」都是需要确认的信息，
   * 自动消失 = 把这件事隐瞒掉（ux-spec §1.6）。 */
  function armAutoClose() {
    clearAutoClose();
    if (S.resultPhase !== 'done') return;
    rsTimer = setTimeout(function () { closeResult(true); }, rsAutoMs());
  }
  function clearAutoClose() {
    if (rsTimer) { clearTimeout(rsTimer); rsTimer = null; }
  }
  /* 暂停：mouseenter / focusin / 任意 keydown。
   * mouseleave ⇒ **重新计满 3.2s**（不是续上剩余）；focusin 之后**不恢复**
   * —— 键盘 / 读屏用户一旦开始交互，就交给他手动关。 */
  function pauseAuto(permanent) {
    clearAutoClose();
    if (permanent) rsPaused = true;
  }
  function resumeAuto() {
    if (S.resultPhase === 'done' && !rsPaused) armAutoClose();
  }
  /* 3.2s 单一来源：CSS 的 --rs-auto（visual-spec §5.4 要求别两处写） */
  function rsAutoMs() {
    var v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rs-auto'));
    return v > 0 ? v : 3200;
  }

  /* 关闭结果卡（3.2s 到 / 点按钮 / Esc / 切榜期四条路径共用） */
  function closeResult(fromUser) {
    clearAutoClose();
    var modal = scModal();
    if (!modal) return;
    if (!S.resultPhase) { finishCloseResult(fromUser); return; }
    if (motion()) {
      modal.classList.add('is-out');
      var done = false;
      var fin = function () {
        if (done) return;
        done = true;
        modal.classList.remove('is-out');
        finishCloseResult(fromUser);
      };
      /* ⚠️ animationend 会冒泡（六摞牌的 scDeal 就是）—— 只认 modal 自己那一帧 */
      var onEnd = function (e) { if (e.target === modal) fin(); };
      modal.addEventListener('animationend', onEnd, { once: true });
      setTimeout(fin, 420);
    } else {
      finishCloseResult(fromUser);
    }
  }
  /* ⚠️ 焦点必须在 resetResult() **之后**给 —— 那时候 showScoring(false) 已经把
   *    .bd-hd 的 inert 摘掉了；提前 focus 会被 inert 静默吞掉（实测焦点掉到 body）。 */
  function finishCloseResult(fromUser) {
    resetResult();
    if (fromUser) focusBtnFresh();
  }

  /* 结果卡的现场复位：清 .is-result、清冻结高度、清内容、关弹窗、解 inert。
   * ⚠️ 不调 paint() —— finishReady() 里已经画过一次（在遮罩底下），
   *    再画一遍会让扇形牌阵重播入场动画，而且 URL 带 ?track= 时会直接跳进详情。 */
  function resetResult() {
    var modal = scModal(), res = $('#scResult');
    S.resultPhase = null;
    S.progSnap = null;
    if (res) {
      res.hidden = true;
      res.classList.remove('is-fresh');
      var host = $('#rsTracks');
      if (host) host.innerHTML = '';
      var ico = $('#rsIco');
      if (ico) { ico.innerHTML = ''; ico.classList.remove('is-stopped'); }
      var pctIn = $('#rsPctIn');
      if (pctIn) pctIn.style.removeProperty('--cf-pct');
    }
    if (modal) { modal.classList.remove('is-result'); modal.style.height = ''; }
    showScoring(false);
  }

  function focusBtnFresh() {
    var b = $('#btnFresh');
    if (b && !b.disabled) { try { b.focus(); } catch (e) {} }
  }

  /* ================= ① Header 内联确认条（决策段） =================
   *
   * ⭐ 一句话记忆：**确认条 = 「用一个新结果覆盖一个已有结果」的确认。
   *   没有旧结果就没有确认条。**（确认的对象是「旧结果」，不是「耗时」。）
   *
   * 四个入口只有 E1（Header「重新评分」）会拦，且只在 S.data !== null 时拦：
   *   · ready 有牌 / ready 0 张（S.data 非 null）→ 拦；
   *   · failed 且有旧榜 → 拦（.cf-meta 用 S.data.generatedAt = 上次成功那轮）；
   *   · none / canceled / failed 无旧榜（S.data === null）→ **直通**（没有可覆盖的结果）；
   *   · idle / loading / building → 不展开 + 按钮 disabled。
   * E2（.sys 三张卡的按钮）**一律不拦** —— 那张卡本身就是完整的代价说明 + 明确动词，
   * 再叠一次确认是重复征税。E3（切榜期）/ E4（boot）也不拦。 */
  function cfEligible() {
    return !!S.data && ['idle', 'loading', 'building'].indexOf(S.status) < 0 && !S.canceling;
  }

  /* .cf-meta = 「上次 MM-DD HH:mm · 用时 X′YY″」。
   * 三级降级（B16）：payload 无 ms ⇒ 省略「用时」（不留空占位符）；
   * S.data 无 generatedAt ⇒ 「上次结果还在下面」。 */
  function cfMetaText() {
    if (!S.data || !S.data.generatedAt) return '上次结果还在下面';
    var s = '上次 ' + fmtMD(new Date(S.data.generatedAt));
    if (typeof S.data.ms === 'number' && S.data.ms > 0) s += ' · 用时 ' + fmtDur(S.data.ms);
    return s;
  }

  /* ⚠️ 量宽顺序是硬约束（B17）：**写文案 → 量 cfIn.offsetWidth → 最后 add('is-open')**。
   * 反了会量到 --cf-w 上一版的值，动画从错误起点开始。
   * （visibility:hidden 不移除布局，收起态照样量得到正确宽度。） */
  function cfOpen() {
    if (!cfEligible()) return false;
    var slot = $('#cfSlot'), bar = $('#bdCf'), inn = $('#cfIn');
    if (!slot || !bar || !inn) return false;
    var txt = $('#cfTxt'), meta = $('#cfMeta');
    if (txt) txt.textContent = '重新抓取并打分 · 约 1~2 分钟';
    if (meta) meta.textContent = cfMetaText();
    var w = inn.offsetWidth;
    if (w) {
      /* 左右内距两档不同（站点 22 / 浮层 18）—— 实测而不是写死 */
      var cs = getComputedStyle(bar);
      var pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      bar.style.setProperty('--cf-w', Math.ceil(w + pad) + 'px');
    }
    slot.classList.add('is-open');
    /* ◆焦点落在**容器本身**（tabindex="-1"），不直接 focus 主按钮：
     * 这是「先读代价再决定」的控件 —— 焦点落在「开始重评」上会让顺手回车直接开跑，
     * 正是加这条确认条要避免的事。（也顺手接住了 visibility:hidden 导致的失焦回落 body。）
     * Tab 仍能走到 .cf-go / .cf-no。
     *
     * ⚠️ `preventScroll: true` 是实测补的（不是可选的洁癖）：
     *   .board 的 min-content 宽是 1440 —— 窗口窄于它时整块横向溢出
     *   （实测 1180 视口下 boardW 仍是 1440、横向可滚 260px）。
     *   而 .bd-cf 是 `position:absolute; right:100%`，钉在右锚定的 .cf-slot 左缘 ——
     *   也就是贴着溢出区的右端。裸 focus() 会触发浏览器的「滚进可视区」：
     *   横向 scrollLeft 直接被顶到最大值 260 ⇒ 整块版面瞬间左移 260px，
     *   .rng 从 x=1229 跳到 969，「零位移」当场作废。
     *   确认条永远长在用户刚点过的那个按钮旁边（本来就在视野里），
     *   这一次自动滚动**不可能带来任何可见性收益**，只可能带来跳动 ⇒ 关掉。 */
    try { bar.focus({ preventScroll: true }); } catch (e) {}
    return true;
  }

  /* 收起。⚠️ 只在「点取消」与「Esc」两条路径把焦点还给 #btnFresh ——
   * 点外部收起**不抢焦点**（用户点哪，焦点就该在哪）。 */
  function cfClose(returnFocus) {
    var slot = $('#cfSlot');
    if (!slot || !slot.classList.contains('is-open')) return;
    slot.classList.remove('is-open');
    if (returnFocus) focusBtnFresh();
  }

  /* 新一轮打分（确认条确认 / 直通两条路都走这里）：
   * load(true) 之前快照旧榜张数（结果卡的 delta 要用）。
   * ⚠️ S.prevCounts 只在「这一轮会覆盖一个已有结果」时才有值 ——
   *    首评（S.data === null）时为 null，结果卡就**不显示任何 delta**。 */
  function startFresh() {
    if (S.pending || S.status === 'idle' || S.status === 'loading' ||
        S.status === 'building' || S.canceling) return;
    S.prevCounts = countsOf(S.data);
    S.progSnap = null;
    S.resultPhase = null;
    load(true);
  }

  /* ---------------- 渲染：系统状态 ---------------- */

  var ICO_EMPTY = '<svg width="34" height="34" viewBox="0 0 34 34"><rect x="7" y="4" width="17" height="24" rx="3" fill="#fff" stroke="#D6DBE0" stroke-width="1.5" transform="rotate(-6 15.5 16)"/><rect x="11" y="6" width="17" height="24" rx="3" fill="#fff" stroke="#C9CDD4" stroke-width="1.5"/><path d="M16 15h7M16 19.5h4.5" stroke="#DFE3E8" stroke-width="1.5" stroke-linecap="round"/></svg>';
  var ICO_FAIL = '<svg width="34" height="34" viewBox="0 0 34 34"><circle cx="17" cy="17" r="13" fill="none" stroke="#E8734A" stroke-width="1.8"/><path d="M17 10v8.5" stroke="#E8734A" stroke-width="1.8" stroke-linecap="round"/><circle cx="17" cy="23" r="1.2" fill="#E8734A"/></svg>';
  /* ◆ICO_CANCEL（v4/v5 定稿，日榜首评被撤销的落点）：
   *   牌 rect 17×24 rx=3 —— 与 ICO_EMPTY 前面那张**逐字段一致**（一眼同族），
   *   靠**逆时针回退弧箭头**区分来路、靠**中性灰**区分性质。
   * ⚠️ 三个"不许"：不是斜杠划掉（划掉 = 对对象的否定：作废/报废/删除，而这一格
   *    被撤销的是「这一轮评分」，旧榜恰恰是唯一没被动过的东西）；不用 --fail 橙红
   *    （撤销 ≠ 失败）；不用 --warn 琥珀（琥珀 = 产物不完整，撤销是完整回到起点）。 */
  var ICO_CANCEL = '<svg width="34" height="34" viewBox="0 0 34 34">' +
    '<rect x="11" y="6" width="17" height="24" rx="3" fill="#fff" stroke="#C9CDD4" stroke-width="1.5"/>' +
    '<path d="M7.5 20.5a9.6 9.6 0 0 1 9.3-9.4" fill="none" stroke="#8A9099" stroke-width="1.8" stroke-linecap="round"/>' +
    '<path d="M17.2 8.6l-.7 2.7-2.7-.6" fill="none" stroke="#8A9099" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  function totalCards() {
    if (!S.data || !S.data.boards) return 0;
    return S.data.boards.reduce(function (n, b) { return n + b.top.length; }, 0);
  }

  function paintSys() {
    var st = S.status;
    var show = false, ico = '', title = '', sub = '', bar = false, btn = '';

    /* ⭐ v1.3.3：「评分中」一律走发牌**弹窗**（无论有没有旧榜）——
     * 弹窗遮罩自己压暗页面，旧榜在遮罩下当背景。.sys 只管
     * failed / none（周榜未评）/ 空榜 / ◆撤销 四种静止状态。
     *
     * ⚠️ v1.4：结果态（S.resultPhase 已置）**不要收弹窗** ——
     * 切结果卡的第一步就是 setStatus('ready')，这里一收就把弹窗 hidden 了，
     * 后面量不到 offsetHeight、结果卡也没地方挂。 */
    if (st === 'building') {
      showScoring(true);
    } else if (!S.resultPhase) {
      showScoring(false);
    }

    if (st === 'none') {
      /* v1.3.1 周榜没评过（hold 返回 none）：绝不自动开跑，
       * 把「翻 45 页 / 一两分钟 / 烧 token」的决定权交给按钮。 */
      show = true; ico = ICO_EMPTY; title = '周榜还没评过分';
      sub = '第一次要翻约 45 页、一两分钟。你说了算 —— 点「开始评分」才开跑，中途可随时提前结束（以已读数据为准）。';
      btn = '开始评分';
    } else if (st === 'failed') {
      show = true; ico = ICO_FAIL; title = '这次没算出来';
      /* ◆「在下方」是 v0.7 时代 footer 上那个重新评分按钮的残留，
       *   那个按钮已经不在了 ⇒ 改为「还在页面上」。 */
      sub = (S.err || '接口异常') + '。已经算好的榜单没丢，还在页面上 —— 可以稍后重新评分。';
      btn = '重试';
    } else if (st === 'canceled') {
      /* ◆撤销后的「没评过」。与 none 的区别必须说清：这是你撤掉的，不是坏了，
       * 也不是「评了 0 张」。零语义色：图标中性灰、文字 --ink3、不加任何类。 */
      show = true; ico = ICO_CANCEL; title = '已撤销 · 这次没出榜';
      sub = '刚那轮评分已经撤掉，什么都没落盘。这是「还没评过」，不是「评了 0 张」—— 想好了随时再来。';
      btn = '重新评分';
    } else if (st === 'ready' && totalCards() === 0) {
      show = true; ico = ICO_EMPTY; title = (S.range === 'week' ? '本周' : '今日') + '暂无上榜';
      sub = '候选不够，或内容都不达标 —— 榜单宁可空着，也不硬凑第一名。换个范围试试。';
    }

    sysEl.hidden = !show;
    if (!show) return;
    $('#sysIco').innerHTML = ico;
    $('#sysTitle').textContent = title;
    $('#sysSub').textContent = sub;
    $('#sysBar').hidden = !bar;
    var b = $('#sysBtn');
    b.hidden = !btn;
    b.textContent = btn;
    /* E2：.sys 三张卡（开始评分 / 重试 / 重新评分）**一律不叠确认条** ——
     * 那张卡本身就是完整的代价说明 + 明确动词，再拦一次是重复征税。
     * 但 delta 快照照做（failed 有旧榜时重试，结果卡要给得出增减）。 */
    b.onclick = function () { startFresh(); };
  }

  /* ---------------- 渲染：六摞牌 ---------------- */

  /* 封面牌 = **我们自己的版式（文字全实时）+ 从参考图里抠出来的角色**。
   *
   * ⭐ 三次改版才对，别再走回头路：
   *   1) v0.4.0 自绘卡面 + 换一版插画 → 用户说「图片样式跟参考图没保持一致」
   *      （根因是我们复刻不出参考图那套字，不是插画的问题）。
   *   2) v0.5.0 从参考图里切牌面凑 1:1.4 → 「贴图太丑了」。
   *   3) v0.5.1 整张参考牌直接用 → 「是把角色抠出来，**不是把整张图都放进去**，
   *      贴在原有的那个卡片上，现在卡片看起来特别奇怪」。
   *   ⭐ 结论：参考图里**值钱的是角色**，不是它的框和烤死的文案。
   *      所以只抠角色当插画，名次/分数/赛道名/定义/入口全部回到我们自己的版式，
   *      顺带把 v0.5.1 丢掉的那个动态值（最高分）拿回来。
   *
   * 空榜（合法状态，spec 6.4）：名次显 0、分数显 —、入口显「暂无上榜」，
   * 不另做占位图，靠 .stack.empty 降不透明度提示。 */
  /* ⭐ v1.0 版式（按用户给的参考图重排）：顶「名次 + 分数」→ 中「角色」→ 下「赛道名 + 定义」→ 底「入口」。
   *   v1.2（用户新参考图·圆蛋吉祥物版）只换质感不换栈序：角色 = 从新参考图里
   *   抠出来的六只蛋（extract_egg_mascots.py，v0.6.0「版式归版式、素材归素材」仍成立）；
   *   赛道名 = 马善政毛笔体逐字跳动（见下面 <i> 那行）、定义 = 龙藏手写 + 波浪线、
   *   入口 = 浅灰胶囊（这三样都在 board.css，字体由 board.html 的 Google Fonts 引入）。
   *   与 v0.6.0 的差别只有两处，但都是参考图的重点：
   *     ① 赛道名从**角色上方**移到**角色下方**并放大（参考图里它是视觉重心，压在角色脚上）；
   *     ② 多一层背景碎片（decoSVG），角色不再是「白底上一个孤零零的形象」。
   *   颜色一律走 CSS 变量 --tc（由 paintFeature 写在 .fx 上）—— 原来每个元素各写一次
   *   内联 color，六处颜色散在字符串里，改配色要改六遍。 */
  function coverHTML(b) {
    var empty = !b.top || !b.top.length;
    var best = empty ? null : b.top[0];
    return '' +
      decoSVG(b.id) +
      '<div class="cover-top">' +
        '<span class="left">' +
          '<span class="cv-sym">' + sym(b.id, 20) + '</span>' +
          '<b class="cover-rank">' + (empty ? '0' : '1') + '</b>' +
        '</span>' +
        '<b class="cover-score' + (empty ? ' is-empty' : '') + '">' +
          (empty ? '—' : best.score.toFixed(1)) + '</b>' +
      '</div>' +
      '<div class="cover-fig" style="background-image:url(cards/' + CARD_CHAR[b.id] + '.png)"></div>' +
      /* v1.2：赛道名逐字包 <i>（CSS 按 nth-child 给每字不同的微旋/错位）——
       * 参考图的马克笔大字就是「每个字各有各的角度」。空格不包，保持词距。 */
      '<div class="cover-name">' +
        String(b.name).split('').map(function (ch) {
          return ch === ' ' ? ' ' : '<i>' + esc(ch) + '</i>';
        }).join('') +
      '</div>' +
      /* ⚠️ 空榜时定义行与入口**不能都写「暂无上榜」** —— 两行同文案挨在一起，
       *    第一版出图后像渲染重复。定义行保留「暂无上榜」这个数据事实，
       *    入口退回「查看赛道 →」，与正常态的「点击进入 →」同构。 */
      '<div class="cover-def">' + (empty ? '今日暂无上榜' : esc(b.def)) + '</div>' +
      '<div class="cover-go">' +
        '<span class="cv-sym">' + sym(b.id, 13) + '</span>' +
        (empty ? '查看赛道 →' : '点击进入 → 看完整榜单') +
      '</div>';
  }

  /* 扇面位次名（v1.1）：与 board.css 的 .fx[data-pos=…] 选择器一一对应，
   * 改那边的选择器要同步改这里。
   * ±2 以内进扇；更远的滑出扇外淡出（off-*）。
   * dir（行进方向 ±1）只影响扇外那张的 off 侧：换位中它沿**反方向**退出
   * （next2 往右出、prev2 往左出），视觉上就是「整扇往行进方向挪一格」。 */
  function fanPos(d, dir) {
    if (d === 0) return 'cur';
    var side = d < 0 ? 'prev' : 'next';
    if (Math.abs(d) > 2) {
      if (dir) return dir > 0 ? 'off-l' : 'off-r';
      return d < 0 ? 'off-l' : 'off-r';   // 静态重排（paintFeature）：按符号，两侧都不可见
    }
    return side + (Math.abs(d) === 2 ? '2' : '');
  }

  /* 环形差值：把 (i - fidx) 归一到 (-n/2, n/2]。
   * ⭐ v1.1.1 环形修复：不环形的话选到首/末赛道时扇面缺成三张
   *   （「最旁边那张不见了」）；首尾相接后任何时刻都是满五张扇面，
   *   六张里恰好一张在扇外（n=6 时 ±3 同距，就是「对面那张」）。 */
  function fanDelta(i, fidx, n) {
    var d = ((i - fidx) % n + n) % n;
    if (d > n / 2) d -= n;
    return d;
  }

  /* 首页扇面：六张赛道牌全渲染（含扇外的 off-*，opacity:0 收着）。
   * ⚠️ 换赛道时**只改 data-pos、不重建** —— innerHTML 一重建，新元素没有
   *    「旧位置」可从，CSS 过渡就成了跳变；全量留着才能整扇滑动。
   *    重建（首次/换榜期/跨多张跳）套 .instant 直接落位，不播入场动画。 */
  function paintFeature() {
    var bs = (S.data && S.data.boards) || [];
    fslotEl.classList.add('instant');
    fslotEl.innerHTML = bs.map(function (b, i) {
      var empty = !b.top || !b.top.length;
      /* --tc = 赛道色，整张卡（描边 / 名次 / 分数 / 赛道名 / 入口 / 背景碎片）
       * 都从它派生；写在 .fx 上由 .cover 继承，一处改色全卡跟。
       * data-i = 赛道下标 —— fslideTo 靠它原地换 data-pos，不重建 DOM。 */
      return '<div class="fx' + (empty ? ' empty' : '') +
        '" data-i="' + i + '" data-pos="' + fanPos(fanDelta(i, S.fidx, bs.length)) + '"' +
        ' style="--tc:' + b.color + '">' +
        '<div class="cover">' + coverHTML(b) + '</div></div>';
    }).join('');
    void fslotEl.offsetWidth;            // 强制回流，让 .instant 盖住这次落位
    fslotEl.classList.remove('instant');
    var cur = bs[S.fidx];
    fslotEl.setAttribute('role', 'button');
    fslotEl.setAttribute('tabindex', '0');
    fslotEl.setAttribute('aria-label', cur
      ? (cur.name + (cur.top.length ? '，' + cur.top.length + ' 张，回车进入' : '（暂无上榜）'))
      : '正在取数');
  }

  /* 小卡条：六张赛道卡（首字 + 赛道色选中态），点谁切谁。title 带张数。 */
  function paintStrip() {
    var bs = (S.data && S.data.boards) || [];
    stripEl.innerHTML = bs.map(function (b, i) {
      var empty = !b.top || !b.top.length;
      return '<button class="fchip' + (i === S.fidx ? ' on' : '') + (empty ? ' is-empty' : '') +
        '" data-j="' + i + '" role="tab" aria-selected="' + (i === S.fidx) +
        '" style="--c:' + b.color + '"' +
        ' title="' + esc(b.name) + ' · ' + (b.top ? b.top.length : 0) + ' 张"' +
        ' aria-label="' + esc(b.name) + (empty ? '（暂无上榜）' : '，' + b.top.length + ' 张') + '">' +
        esc((b.name || ' ').charAt(0)) + '</button>';
    }).join('');
    /* v1.1 行内箭头已撤（扇出的侧牌会压住箭头位），两端可达性交给小卡条本身：
     * 第一张/最后一张就是天然的边界标识。 */
  }

  /* ---------------- 渲染：详情大牌 ---------------- */

  function bigCardHTML(b, it) {
    var dims = (it.dims || []).map(function (d) { return esc(d.k) + ' ' + d.v.toFixed(1); }).join(' · ');
    return '' +
      '<div class="bigcard">' +
        '<div class="bc-top">' +
          '<span class="left">' +
            '<b class="bc-rank" style="color:' + b.color + '">' + it.rank + '</b>' +
            '<span style="color:' + b.color + '">' + sym(b.id, 16) + '</span>' +
          '</span>' +
          '<b class="bc-score" style="color:' + b.color + '">' + it.score.toFixed(1) + '</b>' +
        '</div>' +
        '<div class="bc-fig" style="background-image:url(cards/' + CARD_ART[b.id] + '.png)"></div>' +
        (it.verdict ? '<div class="bc-verdict" style="color:' + b.color + '">「' + esc(it.verdict) + '」</div>' : '') +
        '<div class="bc-text">' + esc(it.content) + '</div>' +
        (dims ? '<div class="bc-dims">' + dims + '</div>' : '') +
        '<div class="bc-line"></div>' +
        '<div class="bc-foot">' +
          '<span>@' + esc(it.user) + '</span>' +
          '<span class="meta">赞 ' + it.digg + ' · 评 ' + it.cmt + '</span>' +
        '</div>' +
        '<a class="bc-go" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">看原文</a>' +
      '</div>';
  }

  /* 三张卡（prev / cur / next）叠在同一格；越界的位次不渲染 */
  function paintCards() {
    var b = board();
    if (!b) { slotEl.innerHTML = ''; return; }
    var n = b.top.length;
    var parts = [];
    [-1, 0, 1].forEach(function (d) {
      var i = S.idx + d;
      if (i < 0 || i >= n) return;
      parts.push('<div class="cx" data-pos="' + (d === 0 ? 'cur' : (d > 0 ? 'next' : 'prev')) + '">' +
        bigCardHTML(b, b.top[i]) + '</div>');
    });
    slotEl.innerHTML = parts.join('');
  }

  function paintTrack() {
    var b = board();
    if (!b) { trackEl.innerHTML = ''; return; }
    var n = b.top.length;
    var html = '';
    for (var i = 0; i < n; i++) {
      /* 卡面上标名次序号（与大牌左上角的 rank 同源）—— 缩略卡本来就没信息量，
       * 光看长短猜不出第几张；标上序号后小卡 = 「可点的大牌索引」。 */
      html += '<button class="thumb' + (i === S.idx ? ' on' : '') + '" data-i="' + i + '" ' +
        'style="' + (i === S.idx ? 'color:' + b.color : '') + '" ' +
        'aria-label="第 ' + (i + 1) + ' 张"' + (i === S.idx ? ' aria-current="true"' : '') + '>' +
        (b.top[i].rank || i + 1) + '</button>';
    }
    trackEl.innerHTML = html;
    /* 条数少时（轨道放得下）居中留白，不做拉伸填充 */
    var gap = 6, need = n * 24 + (n - 1) * gap;
    trackEl.classList.toggle('narrow', need <= trackEl.clientWidth);
    var on = trackEl.querySelector('.thumb.on');
    if (on && !trackEl.classList.contains('narrow')) {
      /* 当前项滚到可视区中间 */
      var left = on.offsetLeft, w = on.offsetWidth;
      trackEl.scrollTo({ left: Math.max(0, left - (trackEl.clientWidth - w) / 2), behavior: motion() ? 'smooth' : 'auto' });
    } else if (trackEl.classList.contains('narrow')) {
      trackEl.scrollLeft = 0;
    }
  }

  function paintChrome() {
    var b = board();
    var n = b ? b.top.length : 0;
    $('#crumbCur').textContent = b ? (b.name + ' · 共 ' + n + ' 张') : '—';
    $('#opsNum').textContent = '第 ' + (n ? S.idx + 1 : 0) + ' 张 / 共 ' + n + ' 张';
    /* 只剩 1 张时左右箭头同时置灰 */
    $('#btnPrev').disabled = !n || S.idx <= 0;
    $('#btnNext').disabled = !n || S.idx >= n - 1;
  }

  /* ---------------- 视图切换 ---------------- */

  /* 只把详情内容画出来，不动可见性 —— 发牌时要先在「可见但透明」的状态下量矩形，
   * 因为 hidden 元素的 getBoundingClientRect() 全是 0。 */
  function paintDetail() {
    paintCards(); paintTrack(); paintChrome();
  }

  function showDeal() {
    viewDetail.hidden = true;
    viewDeal.hidden = false;
    S.trackId = null;
    if (q.get('track')) {
      q.delete('track');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
    }
  }

  function showDetail() {
    viewDeal.hidden = true;
    viewDetail.hidden = false;
    paintDetail();
    q.set('track', S.trackId);
    history.replaceState(null, '', location.pathname + '?' + q.toString());
  }

  /* ---------------- 发牌：点一摞 → 顶牌飞到牌台中央（320ms） ----------------
   * 飞行层挂在 body 下（不在 .board 里），刻意不参与 --k 缩放：
   * 这样 clone 始终按设计像素**导出尺寸**渲染，再靠 scale 追平视觉尺寸。
   * ⭐ 封面牌与详情大牌同为 1:1.4 → **单轴等比缩放**即可（--s0 出发 / --s 落位）。
   *    （v0.5.1 那版封面是 1:1.218、大牌 1:1.4，比例不同才需要分轴。）
   *
   * ⭐ v0.8.2：飞的内容从**封面牌**换成**详情大牌的缩略版**。
   *   原来飞的是 `coverEl.outerHTML`，于是整个 320ms 里用户看到的是一张
   *   写着「emo 榜 / 点击进入 →」的**封面小牌**在放大，落位后突然整张换成
   *   详情大牌（名次 / 分数 / 判词 / 看原文）—— 一次明显的内容突变，
   *   而且「点击进入」这个按钮飞到了详情页，语义上已经过期。
   *   改飞大牌的clone 后：飞过去的就是落位后那张牌，**内容全程不变**，
   *   视觉上只剩位移+缩放这一件事（spec §6.2「顶牌飞到牌台中央并放大到详情尺寸」
   *   说的就是这件事）。 */
  function makeFlyer(srcEl, from, to, dw, dh) {
    var flyer = document.createElement('div');
    flyer.className = 'flyer';
    flyer.style.left = from.left + 'px';
    flyer.style.top = from.top + 'px';
    /* 设计尺寸由调用方传（v0.9.0 起首页大牌是 300x420，不再是封面小牌 202x283）：
     * 视觉尺寸 = 设计尺寸 x k → scale 就是「视觉宽 / 设计宽」；同比例所以只算宽度 */
    flyer.style.width = dw + 'px';
    flyer.style.height = dh + 'px';
    flyer.innerHTML = srcEl.outerHTML;
    flyer.style.setProperty('--s0', (from.width / dw).toFixed(4));
    flyer.style.setProperty('--s', (to.width / dw).toFixed(4));
    flyer.style.setProperty('--dx', (to.left - from.left).toFixed(1) + 'px');
    flyer.style.setProperty('--dy', (to.top - from.top).toFixed(1) + 'px');
    flyLayer.appendChild(flyer);
    return flyer;
  }

  function crossFade(big) {
    if (!big) return;
    big.style.transition = 'opacity ' + (motion() ? 140 : 0) + 'ms linear';
    big.style.opacity = '1';
    setTimeout(function () { big.style.transition = ''; big.style.opacity = ''; }, 160);
  }

  function openTrack(trackId) {
    if (S.busy || S.trackId) return;
    var bs = (S.data && S.data.boards) || [];
    var b = null;
    for (var i = 0; i < bs.length; i++) if (bs[i].id === trackId) { b = bs[i]; break; }
    if (!b) return;
    S.busy = true;
    S.trackId = trackId;
    S.idx = 0;
    /* 大牌槽与小卡条必须对齐到要进的赛道（URL ?track= 直达时可能不一致）：
     * viewDeal 此刻多半还可见，重绘要赶在量矩形之前 */
    if (S.fidx !== i) { S.fidx = i; paintFeature(); paintStrip(); }

    if (!motion()) {
      S.busy = false;
      showDetail();
      return;
    }

    /* 先把详情摆出来（透明）并渲染内容，这样才量得到大牌的真实矩形 */
    viewDetail.hidden = false;
    viewDetail.style.opacity = '0';
    paintDetail();
    var big = slotEl.querySelector('.cx[data-pos="cur"] .bigcard');
    if (big) big.style.opacity = '0';

    var cover = fslotEl.querySelector('.fx[data-pos="cur"] .cover');
    var from = cover ? cover.getBoundingClientRect() : fslotEl.getBoundingClientRect();
    var to = cardRect();
    /* 空榜：没有大牌可落，就地淡出 */
    if (!b.top || !b.top.length) to = from;

    /* 首页内容整体淡出让位（旧版是六摞 .deck.leaving），
     * 飞行层是唯一焦点 —— 与 v0.8.2 同一原则 */
    viewDeal.style.transition = 'opacity 200ms linear';
    viewDeal.style.opacity = '0';

    /* ⚠️ 飞的是**大牌的克隆**（v0.8.2 起不变），不是封面牌。
     *   克隆源必须是已经渲染好的 .bigcard —— 它此刻 opacity:0，
     *   但 outerHTML 不带行内 style 之外的状态，且下面立刻把clone
     *   的 opacity 强制成 1（.bigcard 的 opacity:0 是行内样式，
     *   outerHTML 会把它**一起克隆过去**，不处理的话飞出来是张空牌）。 */
    var flyer = makeFlyer(big || cover, from, to, FT_W, FT_H);
    var fclone = flyer.firstElementChild;
    if (fclone) {
      /* 克隆带过来的行内 opacity 要清掉，再由 .flyer 自己控制整体透明度 */
      fclone.style.opacity = '';
      fclone.style.width = '100%';
      fclone.style.height = '100%';
    }

    setTimeout(function () {
      viewDetail.style.opacity = '';
      viewDeal.hidden = true;
      viewDeal.style.opacity = '';
      viewDeal.style.transition = '';
      crossFade(big);
      flyer.style.transition = 'opacity ' + (motion() ? 110 : 0) + 'ms linear';
      flyer.style.opacity = '0';
      setTimeout(function () {
        flyer.remove();
        q.set('track', S.trackId);
        history.replaceState(null, '', location.pathname + '?' + q.toString());
        S.busy = false;
      }, motion() ? 130 : 0);
    }, DUR);
  }

  function closeDetail() {
    if (S.busy || !S.trackId) return;
    var cover = fslotEl.querySelector('.fx[data-pos="cur"] .cover');
    if (!cover || !motion()) { backToDeal(); return; }
    S.busy = true;

    var from = cardRect();
    /* 首页大牌视图先「摆出来但不显示」，否则量不到封面大牌的位置 */
    viewDeal.hidden = false;
    viewDeal.style.opacity = '0';
    var to = cover.getBoundingClientRect();

    var big = slotEl.querySelector('.cx[data-pos="cur"] .bigcard');
    if (big) { big.style.transition = 'opacity 120ms linear'; big.style.opacity = '0'; }

    /* ⚠️ 与 openTrack 配对：飞**大牌的克隆**（v0.8.2 起不变）。
     *   返回全程内容不变，只是缩回首页大牌位。 */
    var flyer = makeFlyer(big || cover, to, from, FT_W, FT_H);
    var fclone2 = flyer.firstElementChild;
    if (fclone2) {
      fclone2.style.opacity = '';
      fclone2.style.transition = '';
      fclone2.style.width = '100%';
      fclone2.style.height = '100%';
    }
    flyer.classList.add('back');

    setTimeout(function () {
      flyer.remove();
      if (big) { big.style.transition = ''; big.style.opacity = ''; }
      viewDetail.hidden = true;
      /* 首页跟着牌一起淡回来 */
      viewDeal.style.transition = 'opacity 200ms linear';
      viewDeal.style.opacity = '';
      setTimeout(function () { viewDeal.style.transition = ''; }, 220);
      showDeal();
      S.busy = false;
    }, DUR_BACK);
  }

  function backToDeal() {
    viewDetail.hidden = true;
    viewDeal.hidden = false;
    viewDeal.style.opacity = '';
    showDeal();
  }

  /* ---------------- 切牌 ---------------- */

  function cardRect() { return slotEl.getBoundingClientRect(); }

  /* ---------------- 抽牌协议（v1.3，机制见 board.css .cx 那块） ----------------
   * 顶牌跟手 = JS 逐帧写 --px/--pr/--under（挂在 .slot 上，.cx 继承）；
   * 抽走 = 挂 .fly + data-dir（飞行终态写在 CSS 里，±56% 相对牌宽，
   * 站点 396 / 浮层 300 自动适配，不再有 dist 换算）。
   * 下面这几个清理函数是「拖拽中途」的现场复位：重建/直跳前不清干净，
   * 新一手的牌会带着上一根手指的偏移起手。 */
  function clearPull() {
    slotEl.style.removeProperty('--px');
    slotEl.style.removeProperty('--py');
    slotEl.style.removeProperty('--pr');
    slotEl.style.removeProperty('--ps');
    slotEl.style.removeProperty('--under');
  }

  function endPullState() {
    slotEl.classList.remove('fly', 'dragging', 'snapping');
    slotEl.removeAttribute('data-dir');
    clearPull();
  }

  /* 抽走第 ni 张：顶牌飞出+淡出，方向底牌放大接位；dur 后落数据重建。
   * 从静止（箭头/键盘）或手指当前位置（拖拽过阈值）起播都成立 ——
   * 过渡终态写在 CSS 状态类上，起点就是当前 computed transform，
   * transition 自动从当前位置接到终态，不需要也不应该重置 --px。 */
  function flyTo(ni, d, dur) {
    if (!motion()) { S.idx = ni; endPullState(); paintDetail(); return; }
    S.busy = true;
    slotEl.setAttribute('data-dir', d > 0 ? 'next' : 'prev');
    slotEl.classList.add('fly');
    setTimeout(function () {
      S.idx = ni;
      endPullState();
      paintDetail();
      S.busy = false;
    }, dur);
  }

  /* 三种换法共用这一条：d=+1 下一张（牌往左抽），d=-1 上一张（往右抽）。 */
  function step(d) {
    var b = board();
    if (!b || S.busy) return;
    var n = b.top.length;
    var ni = S.idx + d;
    if (ni < 0 || ni >= n) return;
    flyTo(ni, d, DUR);
  }

  function bindArrows() {
    $('#btnPrev').addEventListener('click', function () { step(-1); });
    $('#btnNext').addEventListener('click', function () { step(1); });
  }
  bindArrows();

  /* ---------------- 首页切赛道（v1.1：整扇滑位） ----------------
   * 扇面牌阵的换法与详情完全不同：不再推 --dx 让对侧牌平移进来，
   * 而是**六张牌各自换 data-pos** —— CSS 过渡让每张牌沿扇面滑到新位次
   * （cur→prev、next→cur、next2→next…，最外一张滑向 off-* 淡出，
   *  对侧一张从 off-* 滑进来）。全程不重建 DOM（见 paintFeature 注释）。
   * 不加 S.busy 锁：过渡中途再切只是重定目标，transition 自动衔接，
   * 连按 ←→ 是连续滑动而不是一步步顿。 */
  function fstep(d) {
    var bs = (S.data && S.data.boards) || [];
    if (S.busy || !bs.length) return;
    /* v1.1.1 环形换位：首尾相接（毒舌 ←→ emo 互为邻居），
     * 两端不再「按了没反应」—— 原来越界直接 return，还顺带让扇面缺位。 */
    var ni = (S.fidx + d + bs.length) % bs.length;
    fslideTo(ni, d);
  }

  /* 无感瞬移（只给扇外牌用）：off-l / off-r 两侧都是 opacity:0，
   * 在两侧之间挪动本该瞬间完成 —— 不关过渡的话，它会带着淡入
   * 横穿整条扇面（环回断裂处必现，见 fslideTo 里那两条）。 */
  function fxTeleport(el, pos) {
    el.style.transition = 'none';
    el.setAttribute('data-pos', pos);
    void el.offsetWidth;
    el.style.transition = '';
  }

  function fslideTo(ni, d) {
    var bs = (S.data && S.data.boards) || [];
    if (ni < 0 || ni >= bs.length) return;
    var n = bs.length;
    /* 沿环的正向步数：环形换位时 ni - S.fidx 可能是 ∓(n-1)，
     * 「是不是相邻一步」不能看差值，要看环上距离 + 行进方向。 */
    var ring = ((ni - S.fidx) % n + n) % n;
    var adjacent = (d === 1 && ring === 1) || (d === -1 && ring === n - 1);
    /* 相邻一步（含首尾环回）：换 data-pos，整扇各滑一格。
     * 跨多张 / 减动效：整槽重建直接落位 —— 远端牌横穿整条扇面观感乱。 */
    if (motion() && adjacent) {
      S.fidx = ni;
      var cards = fslotEl.children;
      for (var c = 0; c < cards.length; c++) {
        var el = cards[c];
        var nd = fanDelta(Number(el.getAttribute('data-i')), ni, n);
        var op = el.getAttribute('data-pos');
        /* 环回断裂处：本该从左侧进场（nd=-2）的牌却停在右侧扇外
         * （或镜像情形）→ 先瞬移到进场侧再起过渡。两侧都不可见，
         * 瞬移无感；不处理的话那张牌会横穿整条扇面淡入。 */
        if (nd === -2 && op === 'off-r') fxTeleport(el, 'off-l');
        else if (nd === 2 && op === 'off-l') fxTeleport(el, 'off-r');
        el.setAttribute('data-pos', fanPos(nd, d));
      }
      paintStrip();
      return;
    }
    S.fidx = ni;
    paintFeature(); paintStrip();
  }

  function bindTrack() {
    trackEl.addEventListener('click', function (e) {
      var t = e.target.closest('.thumb');
      if (!t || S.busy) return;
      var i = Number(t.getAttribute('data-i'));
      if (!(i >= 0) || i === S.idx) return;
      /* 点缩略卡是「跳过去」不是「翻过去」：直接落位，不播切牌动画 */
      S.idx = i;
      endPullState();
      paintDetail();
    });
  }

  /* ---------------- 键盘 ← → / Esc ---------------- */

  /* ⚠️ v1.4 重写成**六级优先级链**（ux-spec §3.1）：
   *   1 规则弹窗（唯一真模态） > 2 结果卡（关闭） > 3 执行态（把出口递到手边）
   *   > 4 确认条（收起） > 5 详情（关闭） > 6 首页（无 Esc 语义）
   *
   * ★ 顺带修两个既有 bug：
   *   ① **弹窗开着时 ← / → 会穿透到首页分支执行 fstep()**（在遮罩底下静悄悄切了赛道）
   *      —— 原来这里只判断 #ruleMask 与 viewDetail，根本没有 viewScoring 分支；
   *   ② 弹窗开着时按 Esc 同样会落到首页分支（首页没有 Esc 语义，但 ← → 有）。
   *
   * 为什么执行态的 Esc **不做取消也不做关闭**：
   *   · 取消是破坏性操作（撤销整轮、白等 1~2 分钟），Esc 是全键盘最容易误触的键；
   *   · 这个弹窗没有「关闭」语义 —— 它是进度指示器，关掉它任务还在跑，
   *     用户会以为撤销了；
   *   所以 Esc 只**聚焦 .sc-cancel**（不 arm、不触发）：给出即时反馈（焦点环 +
   *   读屏念出「取消本次评分 按钮」），同时不做任何破坏性的事。幂等：重复按无副作用。 */
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;

    /* 1 · 规则弹窗（既有，优先级最高） */
    if (!$('#ruleMask').hidden) {
      if (e.key === 'Escape') closeRule();
      return;
    }

    /* 2 / 3 · 评分弹窗开着：← → 一律吞掉，Esc 按子态分流 */
    var scView = $('#viewScoring');
    if (scView && !scView.hidden) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); return; }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (S.resultPhase) { pauseAuto(true); closeResult(true); return; }
        var c = $('#scCancel');
        if (c && !c.disabled) { try { c.focus(); } catch (_) {} }
        return;
      }
      /* 结果态：任意 keydown 都永久暂停自动关闭（读屏用户在读 ⇒ 别把它关了） */
      if (S.resultPhase) pauseAuto(true);
      return;
    }

    /* 4 · 确认条开着 ⇒ Esc 收起 + 焦点回按钮 */
    var slot = $('#cfSlot');
    if (slot && slot.classList.contains('is-open')) {
      if (e.key === 'Escape') { e.preventDefault(); cfClose(true); }
      return;
    }

    /* 5 · 详情 */
    if (!viewDetail.hidden) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeDetail(); }
      return;
    }
    /* 6 · 首页：← → 切赛道（与详情翻同一套键位直觉），无 Esc 语义 */
    if (viewDeal.hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); fstep(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); fstep(1); }
  });

  /* ◆B18 扩展浮层的 iframe 被销毁时清轮询（防泄漏）。
   * ⚠️ **不自动 cancel** —— 任务留在服务端跑完，下次进来接着看。
   * 这是「撤销要显式」的反面，符合直觉。 */
  window.addEventListener('beforeunload', function () {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    clearAutoClose();
  });

  /* ---------------- 左右滑动（跟手抽牌，v1.3） ----------------
   * 拖拽中顶牌跟着手指走（--px 平移 + --pr 微旋，符号与飞行终态同号衔接），
   * 底牌按进度 --under 长大；松手过阈值 = 从手指位置直接抽走（flyTo），
   * 不过阈值 = 弹回摞上（160ms）。箭头在 .table.dragging 下淡出让位不变。 */
  function bindSwipe() {
    var down = null;
    var cardW = 0;

    tableEl.addEventListener('pointerdown', function (e) {
      if (S.busy || viewDetail.hidden) return;
      if (e.target.closest('.round') || e.target.closest('.bc-go')) return;
      down = { x: e.clientX, dx: 0 };
      cardW = slotEl.offsetWidth;
      tableEl.classList.add('dragging');   // 拖动时两个箭头淡出让位
      slotEl.classList.add('dragging');    // 顶牌跟手：过渡全关（见 CSS）
      try { tableEl.setPointerCapture(e.pointerId); } catch (_) {}
    });

    tableEl.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - down.x;
      /* 首张往右拖 / 末张往左拖 → 阻尼：那边没有牌可抽，「拖不动」的手感 */
      var b = board(), n = b ? b.top.length : 0;
      if ((S.idx === 0 && dx > 0) || (S.idx >= n - 1 && dx < 0)) dx *= 0.32;
      down.dx = dx;
      /* 顶牌跟手：平移 + 微旋（≈0.045°/px，200px 处 ≈9°，与 .fly 终态 ±8° 同号） */
      slotEl.style.setProperty('--px', dx.toFixed(1) + 'px');
      slotEl.style.setProperty('--pr', (dx * 0.045).toFixed(2) + 'deg');
      /* 底牌按拖动进度长上来：到吸附阈值（25% 牌宽）时正好长满接位 */
      var prog = Math.min(1, Math.abs(dx) / Math.max(1, cardW * 0.25));
      slotEl.style.setProperty('--under', (0.96 + 0.04 * prog).toFixed(3));
      /* 方向底牌抬 z：往回抽时别让 next 压着 prev 露错脸（见 CSS data-dir 规则） */
      slotEl.setAttribute('data-dir', dx < 0 ? 'next' : 'prev');
    });

    function end() {
      if (!down) return;
      var dx = down.dx;
      down = null;
      tableEl.classList.remove('dragging');
      /* 松手先放开过渡（.dragging 一摘 CSS 过渡生效），再定终态：
       * 过阈值走 flyTo —— 顶牌从手指当前位置接着飞，不会先弹回再飞。 */
      slotEl.classList.remove('dragging');

      var b = board(), n = b ? b.top.length : 0;
      var d = dx < 0 ? 1 : -1;
      var ni = S.idx + d;
      var th = cardW * 0.25;               // 吸附阈值 = 牌宽 25%

      if (Math.abs(dx) >= th && ni >= 0 && ni < n) {
        flyTo(ni, d, DUR);
        return;
      }

      /* 没过阈值 → 弹回摞上（160ms，--snapdur 让这一段比抽牌短）。
       * 变量就地清掉 → transform 回落到默认值（0 / 0 / .96），过渡接管弹回。 */
      slotEl.style.setProperty('--snapdur', DUR_SNAP + 'ms');
      slotEl.classList.add('snapping');
      slotEl.removeAttribute('data-dir');
      clearPull();
      setTimeout(function () {
        slotEl.classList.remove('snapping');
        slotEl.style.removeProperty('--snapdur');
      }, DUR_SNAP);
    }
    tableEl.addEventListener('pointerup', end);
    tableEl.addEventListener('pointercancel', end);
  }

  /* ---------------- 评分规则弹窗 ---------------- */

  function openRule() {
    var bs = (S.data && S.data.boards) || [];
    var host = $('#ruleTracks');
    host.innerHTML = bs.map(function (b) {
      return '<div class="dlg-tr"><span style="color:' + b.color + ';margin:0">' + sym(b.id, 14) + '</span>' +
        '<b style="color:' + b.color + '">' + esc(b.name) + '</b>' +
        '<span>' + esc(b.def) + '</span></div>';
    }).join('');
    $('#ruleMask').hidden = false;
  }
  /* ◆焦点回到打开它的那个按钮（ux-spec §3.2：现状没做，Esc 关完焦点掉回 body） */
  function closeRule() {
    $('#ruleMask').hidden = true;
    var b = $('#btnRule');
    if (b) { try { b.focus(); } catch (e) {} }
  }

  /* ---------------- 等比缩放（--k） ----------------
   * 与 app.js 的 fitStage 同一套口径与同一个断点 760；
   * 浮层里 --k 由 board.css 强制成 1（榜单在浮层就是 722 的设计）。 */
  function fitStage() {
    var de = document.documentElement;
    if (de.classList.contains('embed')) return;
    var w = de.clientWidth;
    var pad = 24 * 2;
    var k = Math.min(1, (w - pad) / 1440);
    if (w <= 760) k = 1;   // 窄屏交给 CSS 流式版式，不再等比缩
    de.style.setProperty('--k', k.toFixed(4));
  }

  /* ---------------- 启动 ---------------- */

  function paint() {
    paintFeature(); paintStrip();
    /* 有 track 锚（刷新 / 从详情链接进来）就对齐赛道再停到详情 */
    if (S.trackId && board()) {
      var bs = (S.data && S.data.boards) || [];
      for (var i = 0; i < bs.length; i++) {
        if (bs[i].id === S.trackId) { S.fidx = i; break; }
      }
      paintFeature(); paintStrip();
      if (board().top.length) { viewDeal.hidden = true; showDetail(); }
      else { S.trackId = null; showDeal(); }
    } else {
      if (S.trackId) S.trackId = null;
      showDeal();
    }
    paintSys();
    paintRangeCard();
  }

  /* ---------------- 榜期切换（v1.3.2：直切分段按钮，见 spec §6.7）----------------
   * v0.7.0 的榜期卡（时间窗+规模+状态三层、展开两榜对照面板）换成一个
   * 二段开关：点一下就切。面板整个下线 —— 周榜不自动评（v1.3.1 hold）之后，
   * 「切过去看看」零成本（没算过就亮开始屏），切换前对照的诉求消失。
   * 状态那行没丢：rngCap 接过原卡片第二行的全部职责
   * （扫描/评分进度、尚未评分、提前结束、失败、演示标记）。 */
  var RANGES = [
    { id: 'day', tag: '日榜' },
    { id: 'week', tag: '周榜' },
  ];

  function rngStats(d) {
    if (!d || !d.boards) return null;
    var n = 0;
    for (var i = 0; i < d.boards.length; i++) n += (d.boards[i].top || []).length;
    return { scanned: d.scanned || 0, cards: n, tracks: d.boards.length };
  }

  /* 分段选中态 + 状态行（⛰ 评分中 / 失败 / 尚未评分 / 就绪 四态一眼可辨）。
   * 滑块位置写在 #rngSeg 的 data-on 上（CSS transform 滑动），文字色随 .on 切换。 */
  function paintRangeCard() {
    var seg = $('#rngSeg');
    seg.setAttribute('data-on', S.range);
    var btns = seg.querySelectorAll('.rng-seg-btn');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-range') === S.range;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }

    var cap = $('#rngCap');
    cap.classList.remove('is-building', 'is-failed');
    if (S.status === 'failed') {
      cap.classList.add('is-failed');
      var d0 = S.data && new Date(S.data.generatedAt || Date.now());
      cap.textContent = d0 ? (fmtMD(d0) + ' 那次结果') : '暂无数据';
      return;
    }
    if (S.status === 'building') {
      var p = S.progress || {};
      /* ◆撤销期间（v5 补）：`.sc-mask` 是 rgba(23,26,31,.44) **半透明**，Header 在遮罩下
       * 透得出来，`.rng-cap` 这行用户看得到 —— 沿用上一次的 building 文案
       * （停在「正在评分 24/48 条」蓝色）就是一句假话。
       * ⚠️ **不加 `is-building`**：`--go` 蓝在本项目 = 「评分进行中」，而撤销期间
       *    评分已经不在进行了，挂上会把「正在撤销」读成「正在算」。 */
      if (S.canceling || p.cancelling) {
        cap.textContent = '正在撤销本次评分…';
        return;
      }
      cap.classList.add('is-building');
      if (p.stopping) {
        cap.textContent = '已请求结束 · 正在收尾…';
      } else if (p.phase === 'scan') {
        cap.textContent = '正在扫描 · ' + (p.scanned || 0) + ' 条';
      } else if (p.phase === 'score') {
        cap.textContent = '正在评分 ' + (p.done || 0) + '/' + (p.candidates || 0) + ' 条';
      } else {
        cap.textContent = '正在取数…';
      }
      return;
    }
    /* v1.3.1 周榜没评过：把「还没算」这个事实写清楚，别让人以为是坏了 */
    if (S.status === 'none') {
      cap.textContent = '尚未评分 · 点「开始评分」';
      return;
    }
    /* ◆撤销后的日榜：必须显示「已撤销」，不能退回普通的规模行 ——
     * 那等于说「有一份榜」。灰色（默认色），不加 is-failed。
     * （周榜撤销回 none，不加这行 —— 周榜「没评过」是常态，撤销痕迹由 toast 承担。） */
    if (S.status === 'canceled') {
      cap.textContent = '已撤销 · 尚未评分';
      return;
    }

    var st = rngStats(S.data);
    if (!st) { cap.textContent = '正在取数…'; return; }
    cap.textContent = '已扫 ' + st.scanned + ' 条 · 共 ' + st.cards + ' 张';
    /* ◆「· 提前结束」后缀必须用**与结果卡同一个 `gapOf()` 判据**（ux-spec §2.5.1）：
     * 只用 `S.data.stopped` 会出现「结果卡说评分完成、榜期卡说提前结束」的自相矛盾
     * （stopped=true 但 done >= candidates ⇒ 产物完整，两边都该说「完成」）。
     * ◆ 判据只保留 `!== 'none'`（team-lead v3 裁决，推翻其更早那条）：
     *   gapOf() 在这里的唯一用途是排除「产物完整但 stopped 标记残留」那格。
     *   而 gap='unknown' 恰恰**最该加后缀** —— payload 上 stopped:true 是真事实，
     *   只是缺在哪不知道，更需要警示；把它排除等于把信息丢了。
     *   ⇒ 'none' 不加（产物没少，不许说"不完整"）；'score'/'scan'/'unknown' 都加。 */
    if (S.data.stopped && gapOf() !== 'none') cap.textContent += ' · 提前结束';
    if (S.data.mock) cap.textContent += ' · 演示';
  }
  function fmtMD(d) {
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function switchRange(r) {
    if (r === S.range) return;
    S.range = r;
    S.trackId = null; S.idx = 0; S.fidx = 0; S.data = null;
    /* ◆T27：切榜期要清掉 delta / 进度快照 / 结果态 ——
     * 不清的话「日榜的旧榜张数」会被拿去给周榜算 delta（B14 串味）。 */
    S.prevCounts = null; S.progSnap = null;
    /* ◆B4：结果卡还开着时切榜期（键盘 Tab 出去的情况）⇒
     * 先清自动关闭 timer + 关结果卡 + 清冻结高度，再切档。 */
    clearAutoClose();
    if (S.resultPhase) resetResult();
    cfClose(false);
    q.set('range', r); q.delete('track');
    history.replaceState(null, '', location.pathname + '?' + q.toString());
    paintRangeCard();
    syncButtons();
    viewDeal.hidden = false; viewDetail.hidden = true;
    load(false);
  }

  function bind() {
    /* 日榜 / 周榜直切（v1.3.2）：点哪段切哪档。
     * 周榜切过去没算过就亮「开始评分」（load 的 hold 逻辑），不会自动开跑。 */
    $('#rngSeg').addEventListener('click', function (e) {
      var b = e.target.closest('.rng-seg-btn');
      if (!b) return;
      switchRange(b.getAttribute('data-range'));
    });

    /* v1.4「重新评分」：先判断要不要展开确认条（有旧榜 ⇒ 拦），否则直通。
     * ⚠️ 删掉了原来的 setTimeout(2500) 解禁 —— 与实际请求时长无关，
     *    真链路 1~2 分钟时 2.5s 后就解禁了（能重复触发，点了会把发牌台清零）；
     *    缓存命中只要 20ms 却白锁 2.5s。现在禁用由 syncButtons() 绑 S.pending + S.status。 */
    $('#btnFresh').addEventListener('click', function () {
      if (this.disabled) return;
      if (cfOpen()) return;   // 有旧榜 ⇒ 展开确认条（决策段）
      startFresh();           // 无旧榜 ⇒ 直接跑
    });
    $('#cfGo').addEventListener('click', function () {
      if (this.disabled) return;
      cfClose(false);
      startFresh();
    });
    $('#cfNo').addEventListener('click', function () { cfClose(true); });

    /* 发牌台上的「提前结束」：打断抓取/打分，以已读数据组榜（v1.3.1）。
     * 重算中（有旧榜压着）那颗在 .sys 卡片上，走同一个 stopBoard。 */
    $('#scStop').addEventListener('click', function () { stopBoard(); });

    /* 「取消本次评分」：两段式点击（首点 arm，3.5s 内再点才真撤销）。 */
    $('#scCancel').addEventListener('click', function () {
      if (S.canceling || this.disabled) return;
      if (this.classList.contains('is-arm')) { busyCancel(); cancelBoard(); }
      else armCancel();
    });
    /* 焦点离开 ⇒ 退回默认态（arm 只是「手悬在那里」，移开就该撤销那个意图） */
    $('#scCancel').addEventListener('blur', function () { if (!S.canceling) disarmCancel(); });

    /* 结果卡的关闭按钮 */
    $('#rsBtn').addEventListener('click', function () { closeResult(true); });
    /* 自动关闭的暂停 / 重启：
     *   mouseenter ⇒ 暂停（慢读的人）；mouseleave ⇒ **重新计满 3.2s**；
     *   focusin  ⇒ 永久暂停（键盘 / 读屏用户一旦进来，就交给他手动关）。
     * ⭐ 完成态有牌不主动 focus 到按钮，所以鼠标用户根本不产生 focusin ⇒ 正常自动关。 */
    var rsEl = $('#scResult');
    if (rsEl) {
      rsEl.addEventListener('mouseenter', function () { pauseAuto(false); });
      rsEl.addEventListener('mouseleave', function () { resumeAuto(); });
      rsEl.addEventListener('focusin', function () { pauseAuto(true); });
    }

    /* 文档级点击委托，两件互不相关的事（都是「取消一个临时意图」，幂等）：
     *   ① 确认条开着时点 .cf-slot 之外 ⇒ 收起（**不抢焦点**）；
     *   ② 撤销按钮处于 arm 态时点了别处 ⇒ 退回默认态。
     * ⚠️ 点「日榜 / 周榜」时，这个委托与 #rngSeg 的委托**都会触发**，
     *    两者都是幂等（收起 + 切档），顺序无关 —— 不要为了「只执行一个」加互斥标志，
     *    加了反而会漏掉其中一个（ux-spec §1.2）。 */
    document.addEventListener('click', function (e) {
      var slot = $('#cfSlot');
      if (slot && slot.classList.contains('is-open') &&
          !(e.target.closest && e.target.closest('.cf-slot'))) {
        cfClose(false);
      }
      var cb = $('#scCancel');
      if (cb && cb.classList.contains('is-arm') && e.target !== cb) disarmCancel();
    });

    /* 首页牌台：**只有点中中心牌本身**才进详情；
     * 其余区域（侧牌的可见部分会穿透到牌台、以及两侧空白）一律「切赛道」——
     * 落在牌台左半 = 上一个榜，右半 = 下一个榜。
     * v1.1 起行内没有箭头按钮了，这一处委托就是全部点击入口。 */
    ftableEl.addEventListener('click', function (e) {
      if (S.busy) return;
      if (e.target.closest('.fslot')) {
        var bs = (S.data && S.data.boards) || [];
        if (bs[S.fidx]) openTrack(bs[S.fidx].id);
        return;
      }
      var r = fslotEl.getBoundingClientRect();
      fstep(e.clientX < r.left + r.width / 2 ? -1 : 1);
    });
    fslotEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      var bs = (S.data && S.data.boards) || [];
      if (bs[S.fidx] && !S.busy) openTrack(bs[S.fidx].id);
    });
    /* 小卡条：点谁切谁；环上相邻（含 0↔5 跨缝）走滑动，跨多张直接落位（见 fslideTo）。
     * 方向按「环上更近的一侧」定：j<fidx 不一定是往左 —— 在「e」点「毒」
     * 跨缝，短方向是往右环回，猜错方向会退化成整槽重建（动画丢失）。 */
    stripEl.addEventListener('click', function (e) {
      var c = e.target.closest('.fchip');
      if (!c || S.busy) return;
      var j = Number(c.getAttribute('data-j'));
      if (!(j >= 0) || j === S.fidx) return;
      var bs = (S.data && S.data.boards) || [];
      var n = bs.length || 6;
      var ring = ((j - S.fidx) % n + n) % n;
      fslideTo(j, ring <= n - ring ? 1 : -1);
    });
    /* 箭头不单独绑 click —— 见上面 ftable 的委托注释 */

    $('#btnBack').addEventListener('click', closeDetail);
    $('#btnRule').addEventListener('click', openRule);
    $('#ruleClose').addEventListener('click', closeRule);
    $('#ruleMask').addEventListener('click', function (e) { if (e.target === this) closeRule(); });

    bindTrack();
    bindSwipe();

    window.addEventListener('resize', function () { fitStage(); });
    if (window.ResizeObserver) new ResizeObserver(fitStage).observe(document.body);
  }

  function boot() {
    fitStage();
    paintRangeCard();
    bind();
    /* idle 期间「重新评分」就该是禁用的（首拉在飞之前点了是第二个并发请求） */
    syncButtons();
    /* 首屏先摆出大牌的空壳（避免「正在评分」时下面一片空白） */
    if (!S.data) {
      fslotEl.innerHTML = '';
      stripEl.innerHTML = '';
      paintSys();
    }
    load(false);
  }

  boot();
})();
