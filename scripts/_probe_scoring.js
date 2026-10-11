/* 发牌视图的度量脚本（配合 scripts/_cdp.mjs --evaltmpl）
 *
 * 抽出成文件的原因：这段 JS 里全是引号和 $，塞进 bash 命令行会被吃掉两三次
 * （`node -e "setTimeout(()=>{},2500)"` 直接语法错）。同理「能读 DOM 就别读图」——
 * getBoundingClientRect 给的是契约数字，比截图可靠。
 *
 * ⚠️ _cdp.mjs 会把 %LEN% 替成 0，所以下面必须用 slice(0, 4000) 之类的完整取法。
 */
(function () {
  var g = function (id) {
    var e = document.getElementById(id);
    if (!e) return null;
    var r = e.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  };
  var cards = document.querySelectorAll('#scDeck .sc-card');
  var c = cards.length ? cards[0].getBoundingClientRect() : null;
  var piles = [].map.call(document.querySelectorAll('#scDeck .sc-pile'), function (p) {
    return p.querySelectorAll('.sc-card').length;
  });
  var txt = function (id) { var e = document.getElementById(id); return e ? e.textContent : null; };
  return JSON.stringify({
    视口: [document.documentElement.clientWidth, document.documentElement.clientHeight],
    k: getComputedStyle(document.documentElement).getPropertyValue('--k').trim(),
    视图: g('viewScoring'),
    阶段条: g('scPhase'),
    六摞: g('scDeck'),
    发牌台: g('scHall'),
    牌: c ? [Math.round(c.width), Math.round(c.height)] : null,
    牌比例: c ? +(c.width / c.height).toFixed(3) : null,
    六摞张数: piles,
    顶牌数: document.querySelectorAll('#scDeck .sc-card.is-top').length,
    已打分: txt('scDone'),
    待发文案: txt('scHallT'),
    统计文案: txt('scHallS'),
    手牌数: document.querySelectorAll('#scHand i').length,
    阶段步: [].map.call(document.querySelectorAll('#scPhase .sc-step'), function (e) {
      return e.className.replace('sc-step', '').trim() || 'idle';
    }),
    底部溢出: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }).slice(0, 4000);
})()