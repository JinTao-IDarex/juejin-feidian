/* 发牌入场动画的逐帧探针（配合 _cdp.mjs 用）
 * ⭐ 这段此前**完全没被验过** —— 之前只验了详情页内的切牌。
 * 冻到入场动画的 160ms 处（total 320ms），看飞行层与摞的状态。
 */
(function () {
  var ms = Number(new URLSearchParams(location.search).get('freeze') || 160);
  var out = { freezeAt: ms, motionOn: !matchMedia('(prefers-reduced-motion: reduce)').matches };

  var stack = document.querySelector('.stack[data-track="emo"]') ||
    document.querySelector('.stack');
  if (!stack) return JSON.stringify({ err: 'no stack' });
  out.track = stack.getAttribute('data-track');

  /* 入场前的基线：摞在哪、封面多大 */
  var cover = stack.querySelector('.cover');
  var cr0 = cover.getBoundingClientRect();
  out.from = { x: Math.round(cr0.left), y: Math.round(cr0.top), w: Math.round(cr0.width), h: Math.round(cr0.height) };

  stack.click();

  /* 同一帧抓动画并钉住 */
  var all = [];
  [].slice.call(document.querySelectorAll('.flyer')).forEach(function (f, i) {
    f.getAnimations().forEach(function (a) {
      all.push({ who: 'flyer' + i, name: a.animationName, dur: a.effect && a.effect.getTiming().duration });
      try { a.pause(); a.currentTime = ms; } catch (e) {}
    });
  });
  /* 摞自身的 transition（press / taken / leaving 那些）也钉住 */
  [].slice.call(document.querySelectorAll('.stack, .stack .cover, .stack .stack-face')).forEach(function (el, i) {
    el.getAnimations().forEach(function (a) {
      all.push({ who: 'stack' + i, name: a.transitionProperty, dur: a.effect && a.effect.getTiming().duration });
      try { a.pause(); a.currentTime = ms; } catch (e) {}
    });
  });
  out.frozen = all;
  /* 钉住后读实际几何 */
  var fl = document.querySelector('.flyer');
  out.flyer = fl ? (function () {
    var r = fl.getBoundingClientRect();
    var cs = getComputedStyle(fl);
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             radius: cs.borderTopLeftRadius, op: cs.opacity, tf: cs.transform.slice(0, 60) };
  })() : '(无 flyer)';
  out.bigCard = (function () {
    var b = document.querySelector('#slot .bigcard');
    if (!b) return '(无 bigcard)';
    var r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
             op: getComputedStyle(b).opacity };
  })();
  out.deckCls = document.getElementById('deck').className;
  out.detailHidden = document.getElementById('viewDetail').hidden;
  out.dealHidden = document.getElementById('viewDeal').hidden;
  return JSON.stringify(out);
})();