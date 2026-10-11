/* 切牌过程中的「缝」量探针（配合 _cdp.mjs 用）
 * 缝的来源：.cx[data-pos=next] 的位移是 `100% + 16px + dx`，
 * 而 cur 走 `dx` —— 两牌间距恒为 slotW + 16（396+16=412）。
 * 实测两牌**右缘到左缘**的可见空隙 = 16px，整条切牌路径全程不变。
 * ⭐ 16px 是「两张牌并排看一眼」的呼吸位，切牌时应该是 0 ——
 *    真实卡牌堆叠时牌是**贴着**的，能看见缝就像两张独立的卡在飘。
 */
(function () {
  var slot = document.getElementById('slot');
  var next = document.getElementById('btnNext');
  if (!slot || !next || next.disabled) return JSON.stringify({ err: 'no slot/next' });
  var out = { slotW: slot.offsetWidth };

  /* 直接量静止态：cur 在 0，next 在 412 —— 间距就是 412 */
  var nx = slot.querySelector('.cx[data-pos="next"]');
  if (nx) {
    var r0 = slot.querySelector('.cx[data-pos="cur"]').getBoundingClientRect();
    var r1 = nx.getBoundingClientRect();
    out.restGap = Math.round(r1.left - r0.right);
  }

  /* 切牌到一半再量一次（缝应恒定） */
  next.click();
  var res = [];
  var iv = setInterval(function () {
    var c = slot.querySelector('.cx[data-pos="cur"]');
    var n = slot.querySelector('.cx[data-pos="next"]');
    if (c && n) {
      var rc = c.getBoundingClientRect(), rn = n.getBoundingClientRect();
      res.push(Math.round(rn.left - rc.right));
    }
  }, 40);
  return new Promise(function (r) {
    setTimeout(function () {
      clearInterval(iv);
      out.gapsDuringSlide = res;
      out.uniqueGaps = res.filter(function (v, i) { return i === 0 || v !== res[i - 1]; });
      /* 真实间距 = gap - 牌宽的相对关系；再量一次牌的右缘是否越出 slot */
      out.note = 'gap = 下一张左缘 - 当前张右缘（CSS 设计意图 16）';
      r(JSON.stringify(out));
    }, 420);
  });
})();