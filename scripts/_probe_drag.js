/* 拖动路径探针（配合 _cdp.mjs 用）
 * 三件事：
 *  1) 拖动中opacity 是否**立即跟随** --peek（不挂过渡 → 不橡皮筋）
 *  2) 拖过阈值后是否走 .sliding 距离（终点 = cardW，不是 cardW+16）
 *  3) 没过阈值是否弹回、且弹回后 .sliding/.peek 都清干净
 * 用 CDP 的 Input.dispatchMouseEvent 模拟真实指针拖动。
 */
(function () {
  var slot = document.getElementById('slot');
  var table = document.querySelector('.table') || slot.parentElement;
  if (!slot || !table) return JSON.stringify({ err: 'no slot/table' });
  var out = { slotW: slot.offsetWidth };
  var r = slot.getBoundingClientRect();
  var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  function pe(type, x) {
    var ev = new PointerEvent(type, {
      pointerId: 1, isPrimary: true, bubbles: true, cancelable: true,
      clientX: x, clientY: cy, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    });
    (type === 'pointerdown' ? table : table).dispatchEvent(ev);
  }
  function peekNow() {
    var n = slot.querySelector('.cx[data-pos="next"]');
    return n ? +(+getComputedStyle(n).opacity).toFixed(2) : null;
  }
  function dxNow() { return slot.style.getPropertyValue('--dx'); }

  /* --- 1) 小幅拖动（没过阈值，30px）→ 看 opacity 是否立刻跟上 --- */
  pe('pointerdown', cx);
  pe('pointermove', cx - 30);
  out.smallDrag = { dx: dxNow(), peekVar: slot.style.getPropertyValue('--peek'), opacity: peekNow(), sliding: slot.classList.contains('sliding') };
  pe('pointermove', cx - 60);
  out.smallDrag2 = { dx: dxNow(), peekVar: slot.style.getPropertyValue('--peek'), opacity: peekNow() };

  return new Promise(function (res) {
    setTimeout(function () {
      /* 弹回应该已完成（160ms） */
      out.afterSnap = {
        dx: dxNow(), cls: slot.className,
        snapdur: slot.style.getPropertyValue('--snapdur') || '(已清)',
        sliding: slot.classList.contains('sliding'),
        peek: slot.classList.contains('peek'),
      };
      pe('pointerup', cx - 60);
      setTimeout(function () {
        out.afterSnap2 = { dx: dxNow(), cls: slot.className, sliding: slot.classList.contains('sliding'), peek: slot.classList.contains('peek') };

        /* --- 2) 大幅拖动（过阈值，-260px）--- */
        pe('pointerdown', cx);
        pe('pointermove', cx - 260);
        out.bigDrag = { dx: dxNow(), sliding: slot.classList.contains('sliding'), opacity: peekNow() };
        pe('pointerup', cx - 260);
        setTimeout(function () {
          out.afterBig = { dx: dxNow(), cls: slot.className, sliding: slot.classList.contains('sliding'), peek: slot.classList.contains('peek') };
          res(JSON.stringify(out));
        }, 420);
      }, 60);
    }, 260);
  });
})();