(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};
  const cur = () => document.querySelector('#slot .cx[data-pos="cur"]');
  const slot = document.querySelector('#slot');

  out.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  out.htmlClass = document.documentElement.className || '(none)';
  out.chips = [...document.querySelectorAll('#strip .fchip')]
    .map((c) => c.dataset.j + (c.classList.contains('is-empty') ? '(空)' : '')).join(',');

  /* 切到废话榜（data-j=4，4 张牌） */
  document.querySelector('#strip .fchip[data-j="4"]').click();
  await sleep(600);
  document.querySelector('#fslot').click();
  await sleep(800);

  out.opsBefore = document.querySelector('#opsNum').textContent;
  out.slotChildren = document.querySelectorAll('#slot .cx').length;

  /* ---- A. 默认档：应该播动画 ---- */
  document.querySelector('#btnNext').click();
  await sleep(40);
  out.A_full = {
    slotClass: slot.className,
    dx: slot.style.getPropertyValue('--dx'),
    curT: cur() ? getComputedStyle(cur()).transform : null,
    anims: cur() ? cur().getAnimations().map((a) => ({
      p: a.transitionProperty || a.animationName,
      d: a.effect && a.effect.getTiming().duration,
      s: a.playState,
    })) : null,
  };
  await sleep(400);
  out.A_end = document.querySelector('#opsNum').textContent;

  /* ---- B. 强制轻量档：应该直接落位（无 sliding、无过渡） ---- */
  document.documentElement.classList.add('motion-lite');
  document.documentElement.classList.remove('motion-full');
  document.querySelector('#btnNext').click();
  await sleep(40);
  out.B_lite = {
    slotClass: slot.className,
    dx: slot.style.getPropertyValue('--dx'),
    ops: document.querySelector('#opsNum').textContent,
    curT: cur() ? getComputedStyle(cur()).transform : null,
    cssTransition: cur() ? getComputedStyle(cur()).transition : null,
    anims: cur() ? cur().getAnimations().length : null,
  };
  return out;
})()
