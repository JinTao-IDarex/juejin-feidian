/* 切牌动画逐帧探针（配合 _cdp.mjs 用）
 *
 * ⭐ 为什么要逐帧而不是只看终态：
 *   切牌是「三张卡叠在一格 → 一起位移 → 换 idx 重排」的接力，
 *   中间任何一帧错位（牌没跟上、对侧牌提前消失、落位时闪一下）
 *   终态截图全都拍不到 —— 终态永远是对的。
 *
 * 采样内容：
 *   - 三张 .cx 的data-pos / transform（--dx 是否真在动）
 *   - opacity（对侧牌有没有提前没了）
 *   - getAnimations()（动画是否真在 running，而不是只有声明）
 *   - busy（S.busy 是否按期释放，连点会不会卡死）
 */
(function () {
  var out = { motionOn: !matchMedia('(prefers-reduced-motion: reduce)').matches };
  var slot = document.getElementById('slot');
  if (!slot) { out.err = 'no #slot'; return JSON.stringify(out); }

  function snap(tag) {
    var cxs = [].slice.call(slot.querySelectorAll('.cx'));
    return {
      t: Math.round(performance.now()),
      tag: tag,
      dx: slot.style.getPropertyValue('--dx'),
      peek: slot.style.getPropertyValue('--peek'),
      cls: slot.className,
      cards: cxs.map(function (c) {
        var cs = getComputedStyle(c);
        return {
          pos: c.getAttribute('data-pos'),
          tf: cs.transform === 'none' ? 'none' : cs.transform.replace(/matrix\(|\)/g, '').split(',').slice(4).join(','),
          op: (+cs.opacity).toFixed(2)
        };
      })
    };
  }

  /* 采样器：setInterval 16ms 起步（headless 下rAF 会被饿死，只跑 3 帧） */
  var frames = [];
  var timer = null;
  function start(tag) { frames = [snap(tag)]; timer = setInterval(function () { frames.push(snap('f')); }, 16); }
  function stop() { clearInterval(timer); timer = null; }

  var next = document.getElementById('btnNext');
  if (!next) { out.err = 'no #btnNext'; return JSON.stringify(out); }
  out.nextDisabled = next.disabled;

  /* 触发一次切牌 */
  start('before');
  var animsBefore = [];
  next.click();
  /* 点击后立刻取一次 getAnimations（此刻动画刚开始） */
  try {
    animsBefore = [].slice.call(slot.querySelectorAll('.cx')).map(function (c) {
      return c.getAnimations().map(function (a) {
        return { n: a.animationName || a.transitionProperty, st: a.playState, t: a.currentTime };
      });
    });
  } catch (e) { animsBefore = ['err:' + e.message]; }

  return new Promise(function (res) {
    setTimeout(function () {
      stop();
      frames.push(snap('after'));
      out.animsOnFirstFrame = animsBefore;
      out.frames = frames;
      /* 只保留有变化的帧序列的关键信息，避免输出爆炸 */
      out.traj = frames.filter(function (f, i) {
        return i === 0 || i === frames.length - 1 ||
          (i > 0 && JSON.stringify(frames[i - 1].cards) !== JSON.stringify(f.cards));
      }).map(function (f) { return f.t + 'ms dx=' + f.dx + ' ' + f.cards.map(function (c) { return c.pos + '@' + c.op; }).join(' '); });
      /* 连点测试：busy 是否会卡住 */
      return res(JSON.stringify(out));
    }, 700);
  });
})();