/* 返回动画的逐帧探针（配合 _cdp.mjs 用）
 * 验closeDetail：飞回的是不是 .bigcard 克隆（而不是封面牌）。
 * 流程：点一摞 → 等入场结束 → 触发返回 → 冻到 120ms 看飞行层内容。
 */
(function () {
  var ms = Number(new URLSearchParams(location.search).get('freeze') || 120);
  var out = { freezeAt: ms };
  var stack = document.querySelector('.stack[data-track="emo"]') || document.querySelector('.stack');
  if (!stack) return JSON.stringify({ err: 'no stack' });
  stack.click();

  return new Promise(function (res) {
    /* 等入场跑完（DUR 320 + 收尾 130） */
    setTimeout(function () {
      if (!document.querySelector('.flyer')) {
        /* flyer 已移除 → 详情页就位，触发返回 */
        var detailHidden = document.getElementById('viewDetail').hidden;
        if (detailHidden) return res(JSON.stringify({ err: '入场没进详情', detailHidden: detailHidden }));
        var ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        document.dispatchEvent(ev);
        setTimeout(function () {
          var fl = document.querySelector('.flyer');
          var fclone = fl ? fl.firstElementChild : null;
          out.flyerClass = fclone ? fclone.className : '(无 flyer)';
          out.isBigcard = !!(fclone && fclone.classList.contains('bigcard'));
          out.hasCoverGo = !!(fclone && fclone.querySelector('.cover-go'));
          out.hasBcGo = !!(fclone && fclone.querySelector('.bc-go'));
          out.hasBackClass = fl ? fl.classList.contains('back') : null;
          out.flW = fl ? Math.round(fl.getBoundingClientRect().width) : null;
          /* 钉住那一帧 */
          if (fl) fl.getAnimations().forEach(function (a) { try { a.pause(); a.currentTime = ms; } catch (e) {} });
          out.at = fl ? (function () { var r = fl.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; })() : null;
          res(JSON.stringify(out));
        }, 60);
      } else {
        return res(JSON.stringify({ err: 'flyer 还在，320ms 不够' }));
      }
    }, 620);
  });
})();