/* 入场动画「落位那一瞬」的检查（配合 _cdp.mjs 用）
 * 冻到 310ms（DUR=320 的末段），看 flyer 与 bigcard 交接时：
 *  1) flyer 里有没有「点击进入」这个封面按钮
 *  2) 交接瞬间两张牌是否重叠错位
 *  3) bigcard 的透明度是否已回来（crossFade 140ms）
 */
(function () {
  var ms = Number(new URLSearchParams(location.search).get('freeze') || 310);
  var out = { freezeAt: ms };
  var stack = document.querySelector('.stack[data-track="emo"]') || document.querySelector('.stack');
  stack.click();
  var all = [];
  [].slice.call(document.querySelectorAll('.flyer, .bigcard, .stack')).forEach(function (el, i) {
    el.getAnimations().forEach(function (a) {
      all.push({ who: (el.className || el.tagName) + '#' + i, name: a.animationName || a.transitionProperty });
      try { a.pause(); a.currentTime = ms; } catch (e) {}
    });
  });
  out.frozen = all;
  var fl = document.querySelector('.flyer');
  if (fl) {
    out.flyerHTMLShape = {
      hasCoverGoBtn: !!fl.querySelector('.cover-go'),
      coverGoText: fl.querySelector('.cover-go') ? fl.querySelector('.cover-go').textContent.trim() : '(无)',
      hasCoverDef: !!fl.querySelector('.cover-def'),
      classes: (fl.firstElementChild && fl.firstElementChild.className) || '(空)',
      w: Math.round(fl.getBoundingClientRect().width),
      op: getComputedStyle(fl).opacity
    };
  }
  var b = document.querySelector('#slot .bigcard');
  out.big = b ? {
    w: Math.round(b.getBoundingClientRect().width),
    h: Math.round(b.getBoundingClientRect().height),
    op: getComputedStyle(b).opacity,
    hasGoBtn: !!b.querySelector('.bc-go'),
    bcGoText: b.querySelector('.bc-go') ? b.querySelector('.bc-go').textContent.trim() : '(无)'
  } : '(无)';
  out.deckCls = document.getElementById('deck').className;
  return JSON.stringify(out);
})();