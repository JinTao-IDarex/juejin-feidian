/* 切牌：x 位移与 opacity 的同步性探针（配合 _cdp.mjs 用）
 * 目的：量出「位置走到 100%」与「不透明度走到 100%」分别用了多少毫秒。
 * 如果这两个时间差很多，肉眼看到的就是「卡先到位、还在慢慢变实」→ 发飘。
 */
(function () {
  var slot = document.getElementById('slot');
  var next = document.getElementById('btnNext');
  if (!slot || !next || next.disabled) return JSON.stringify({ err: 'no slot/next' });

  var samples = [];
  var t0 = 0;
  function read(tag) {
    var cx = slot.querySelector('.cx[data-pos="cur"]');
    var nx = slot.querySelector('.cx[data-pos="next"]');
    var out = { t: Math.round(performance.now() - t0), tag: tag };
    if (cx) { var m = new DOMMatrixReadOnly(getComputedStyle(cx).transform); out.curX = Math.round(m.m41); }
    if (nx) {
      var m2 = new DOMMatrixReadOnly(getComputedStyle(nx).transform);
      out.nextX = Math.round(m2.m41);
      out.nextOp = +(+getComputedStyle(nx).opacity).toFixed(3);
    }
    return out;
  }

  next.click();
  t0 = performance.now();
  samples.push(read('t0'));
  var iv = setInterval(function () { samples.push(read('s')); }, 12);
  return new Promise(function (res) {
    setTimeout(function () {
      clearInterval(iv);
      samples.push(read('end'));
      /* 找两个各自到达 99% 的时刻 */
      var endCur = samples.length ? samples.filter(function (s) { return s.curX !== undefined; }).pop().curX : 0;
      var tPos = null, tOp = null;
      samples.forEach(function (s) {
        if (tPos === null && s.curX !== undefined && Math.abs(s.curX - endCur) <= Math.abs(endCur) * 0.01 + 1) tPos = s.t;
        if (tOp === null && s.nextOp !== undefined && s.nextOp >= 0.99) tOp = s.t;
      });
      res(JSON.stringify({
        endCurX: endCur,
        endNextX: samples.filter(function (s) { return s.nextX !== undefined; }).pop().nextX,
        pos99ms: tPos, op99ms: tOp, skewMs: (tOp !== null && tPos !== null ? tOp - tPos : null),
        trail: samples.map(function (s) {
          return s.t + 'ms curX=' + s.curX + ' nextX=' + s.nextX + ' nextOp=' + s.nextOp;
        })
      }));
    }, 600);
  });
})();