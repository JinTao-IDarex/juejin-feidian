// 抽卡页顶部「魔鬼榜单」入口的 DOM 度量（配合 _cdp.mjs 用）
(function () {
  var out = { vp: document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight };
  var k = getComputedStyle(document.documentElement).getPropertyValue('--k').trim();
  out.k = k || '(空)';
  var a = document.querySelector('.nav-board');
  if (!a) { out.nav = 'NOT FOUND'; return JSON.stringify(out); }
  var r = a.getBoundingClientRect();
  out.nav = {
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    href: a.getAttribute('href'),
    text: a.textContent.replace(/\s+/g, ' ').trim(),
    border: getComputedStyle(a).borderTopWidth + ' ' + getComputedStyle(a).borderTopColor
  };
  // Hero 里的元素是否被压到 / 溢出
  var hero = document.querySelector('.hero');
  var h1 = document.querySelector('.hero h1');
  var chip = document.querySelector('.chip-tips');
  function bx(el) { var b = el.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }
  out.hero = bx(hero);
  out.chip = bx(chip);
  out.h1 = bx(h1);
  // 与 dock（右下角缩略卡）是否相交
  var d = document.querySelector('.dock');
  if (d) {
    var b = d.getBoundingClientRect();
    out.dock = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    out.overlap = !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
  }
  // chip 那一行是否被入口压住（左边那块）
  out.chipHitByNav = r.right > chip.getBoundingClientRect().left && r.bottom > chip.getBoundingClientRect().top && r.top < chip.getBoundingClientRect().bottom;
  return JSON.stringify(out);
})();