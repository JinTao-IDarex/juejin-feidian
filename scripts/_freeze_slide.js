/* 冻结切牌动画到指定时刻并保持暂停（配合 _cdp.mjs 的 --shot用）
 * 用法：--evalfile 本文件，并在 URL 后加 ?freeze=150
 *   点next → 立刻把所有动画 pause 并钉在 150ms → 返回
 * 这样 --shot 截出来的就是「切牌进行到 150ms」那一帧。
 *
 * ⭐ 为什么必须冻结：headless 截图是异步的，等截图指令真正到达时
 * 320ms 早就播完了 —— 截到的永远是终态，而终态永远是对的。
 */
(function () {
  var ms = Number(new URLSearchParams(location.search).get('freeze') || 150);
  var out = { freezeAt: ms };
  var slot = document.getElementById('slot');
  if (!slot) return JSON.stringify({ err: 'no #slot' });
  var next = document.getElementById('btnNext');
  if (!next || next.disabled) return JSON.stringify({ err: 'btnNext disabled' });

  next.click();
  /* 同一帧内抓 —— 动画刚开始，getAnimations 才拿得到 */
  var all = [];
  [].slice.call(slot.querySelectorAll('.cx')).forEach(function (c, i) {
    c.getAnimations().forEach(function (a) {
      all.push({ i: i, a: a });
      try { a.pause(); a.currentTime = ms; } catch (e) {}
    });
  });
  out.frozen = all.length;
  /* 钉住后读一次实际矩阵：这才是那一帧真实的视觉位置 */
  out.at = [].slice.call(slot.querySelectorAll('.cx')).map(function (c) {
    var cs = getComputedStyle(c);
    var m = new DOMMatrixReadOnly(cs.transform);
    return {
      pos: c.getAttribute('data-pos'),
      x: Math.round(m.m41), y: Math.round(m.m42),
      scale: (+m.a).toFixed(3),
      op: (+cs.opacity).toFixed(2)
    };
  });
  out.dx = slot.style.getPropertyValue('--dx');
  out.slotW = slot.offsetWidth;
  return JSON.stringify(out);
})();