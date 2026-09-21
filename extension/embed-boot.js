/* embed-boot.js — 浮层宿主桥（只在扩展的 host.html 里加载，站点原页不引用）
 *
 * 三件事：
 *   1) 打 html.embed 标记，让 embed.css 的裁剪生效
 *   2) 用 !important 接管 --k（理由见 embed.css 顶部注释）
 *   3) 与父窗口（content.js）交换「展开 / 收起」后的面板尺寸
 */
(function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('embed')) return;

  /* app.js 用 location.protocol 判断「有没有同源代理可用」，
   * 扩展页是 chrome-extension: 协议，本身走不通那条分支，
   * 但接口由扩展宿主提供 —— 这个标记就是让 app.js 放行（构建时的唯一补丁）。 */
  window.__JB_HOST__ = true;

  var de = document.documentElement;
  de.classList.add('embed');

  var DESIGN_W = 1440;                 // 窗口宽 = 舞台整宽（牌阵中心 720 = 窗口中心，见 embed.css）
  var DESIGN_H = 722;                  // 舞台 620 + 间隔 16 + HUD 86（page y 226 → 948）
  var FOLD_W = 196, FOLD_H = 236;      // 收起态：缩略卡 148x196 @ top:20/right:24 + 余量
  var FOLD_MS = 470;                   // 与 app.css 里 .45s 的折叠动画对齐

  /* 自己用 --jb-k，不直接写 --k：原因见 embed.css 顶部那条 !important 规则
   * （直接写 --k 会被 fitStage 的 setProperty 连 !important 一起重置掉）。 */
  var KVAR = '--jb-k';

  function applyK(k) {
    if (!(k > 0)) return;
    de.style.setProperty(KVAR, String(Math.round(k * 1000) / 1000));
  }

  function currentK() {
    /* 读层叠之后的 --k（= --jb-k 经 embed.css 折算过来） */
    var k = parseFloat(getComputedStyle(de).getPropertyValue('--k'));
    return k > 0 ? k : 1;
  }

  function report() {
    if (!document.body) return;
    var folded = document.body.classList.contains('folded');
    var k = currentK();
    parent.postMessage({
      t: 'jb-size',
      folded: folded,
      w: folded ? FOLD_W : Math.ceil(DESIGN_W * k),
      h: folded ? FOLD_H : Math.ceil(DESIGN_H * k)
    }, '*');
  }

  /* 首帧的 k 由宿主用 ?k= 传进来 —— 必须第一帧就对，
   * 否则会先按 k=1 画一次再跳，能看见明显闪动。 */
  if (q.has('k')) applyK(parseFloat(q.get('k')));

  /* ?folded=1：一打开就是缩略卡（右上角那张竖版纸牌），点一下才展开成主卡。
   * 必须在这里同步加类 —— 早于首帧，CSS transition 没有"起始态"可插值，
   * 所以不会播一遍展开动画再收回去。 */
  if (q.has('folded')) {
    document.body.classList.add('folded');
    var dk0 = document.getElementById('dock');
    /* app.js 的 setFolded 才会同步这两个无障碍属性，这里手工补齐 */
    if (dk0) {
      dk0.setAttribute('aria-expanded', 'false');
      dk0.setAttribute('aria-label', '展开页面');
    }
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d) return;
    if (d.t === 'jb-k') { applyK(d.k); report(); }
    else if (d.t === 'jb-resize') { report(); }
    /* 宿主（扩展工具栏图标）要求切展开/收起：
     * 直接点站点自己的 dock 按钮，走的是本来那套 setFolded 逻辑，不另开分支。 */
    else if (d.t === 'jb-dock-click') {
      var dk = document.getElementById('dock');
      if (dk) dk.click();
    }
  });

  /* 站点自己的 dock 按钮负责切 body.folded（app.js setFolded）。
   * 监听 class 变化：收起要等动画播完再缩窗口（不然动画被窗口裁掉），
   * 展开必须立刻放大窗口（不然露不出来）。 */
  new MutationObserver(function () {
    var folded = document.body.classList.contains('folded');
    if (folded) setTimeout(report, FOLD_MS);
    else report();
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.addEventListener('load', report);
  report();
})();
