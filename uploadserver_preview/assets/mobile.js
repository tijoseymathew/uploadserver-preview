/* uploadserver-preview — mobile navigator.
   On narrow screens the explorer sidebar is a bottom sheet. This drives it:
   a titlebar hamburger toggles it, a bottom-edge grip and the sheet's own grab
   handle follow the finger (swipe up to reveal, swipe down to fold), the
   backdrop and Escape close it. Exposes window.PreviewNav so the explorer can
   fold the sheet on file open and reopen it when nothing is shown.
   Progressive enhancement: without this script the sheet CSS still renders and
   the hamburger simply does nothing on desktop, where the sidebar is inline. */
(function () {
  'use strict';

  var app = document.querySelector('.app--shell');
  if (!app) return;
  var sheet = document.getElementById('nav-sheet');
  if (!sheet) return;

  var toggleBtn = document.getElementById('nav-toggle');
  var backdrop = document.getElementById('nav-backdrop');
  var peek = document.getElementById('nav-peek');
  var grab = document.getElementById('sheet-grab');

  var MQ = window.matchMedia('(max-width: 760px)');
  function isMobile() { return MQ.matches; }

  var isOpen = false;

  function clearInline() {
    sheet.style.transition = '';
    sheet.style.transform = '';
  }

  function apply() {
    app.classList.toggle('nav-open', isOpen);
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(isOpen));
    // hide the off-screen sheet from AT only while it's a closed mobile sheet
    sheet.setAttribute('aria-hidden', String(isMobile() && !isOpen));
  }

  function setOpen(v) {
    isOpen = !!v;
    clearInline();      // let the class-driven transform take over
    apply();
  }
  function openNav() { if (isMobile()) setOpen(true); }
  function closeNav() { setOpen(false); }
  function toggleNav() { setOpen(!isOpen); }

  if (toggleBtn) toggleBtn.addEventListener('click', toggleNav);
  if (backdrop) backdrop.addEventListener('click', closeNav);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen) closeNav();
  });

  // Dropping back to desktop: forget any sheet state so the inline layout shows.
  function onMQ() { if (!isMobile()) { isOpen = false; clearInline(); apply(); } }
  if (MQ.addEventListener) MQ.addEventListener('change', onMQ);
  else if (MQ.addListener) MQ.addListener(onMQ);

  // ---- finger-following drag -------------------------------------------------
  // A drag on the bottom grip (sheet closed) or the grab handle (sheet open)
  // translates the sheet with the finger; on release it snaps open/closed by
  // position, and a near-still touch counts as a tap. TAP_SLOP keeps the tap
  // path forgiving without swallowing real drags.
  var TAP_SLOP = 6;    // below this, a touch is a tap not a drag
  var FLICK = 40;      // a decisive swipe this far wins regardless of position
  var drag = null;     // { fromOpen, startY, height, moved }

  function beginDrag(y, fromOpen) {
    if (!isMobile()) return;
    drag = { fromOpen: fromOpen, startY: y, height: sheet.getBoundingClientRect().height, moved: 0 };
    sheet.style.transition = 'none';
  }

  function moveDrag(y) {
    if (!drag) return;
    drag.moved = y - drag.startY;
    var base = drag.fromOpen ? 0 : drag.height;
    var t = Math.max(0, Math.min(drag.height, base + drag.moved));
    sheet.style.transform = 'translateY(' + t + 'px)';
  }

  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    var base = d.fromOpen ? 0 : d.height;
    var current = Math.max(0, Math.min(d.height, base + d.moved));
    var willOpen;
    if (Math.abs(d.moved) < TAP_SLOP) {
      willOpen = !d.fromOpen;                    // a tap flips the sheet
    } else if (d.moved < -FLICK) {
      willOpen = true;                           // a decisive swipe up opens
    } else if (d.moved > FLICK) {
      willOpen = false;                          // a decisive swipe down folds
    } else {
      willOpen = current < d.height * 0.5;       // slow drag: settle by position
    }
    var target = willOpen ? 0 : d.height;
    isOpen = willOpen;
    apply();
    if (Math.abs(target - current) < 1) { clearInline(); return; }
    // animate from the released position to the target, then hand back to CSS
    sheet.style.transition = '';
    sheet.style.transform = 'translateY(' + target + 'px)';
    var done = function () { clearInline(); sheet.removeEventListener('transitionend', done); };
    sheet.addEventListener('transitionend', done);
  }

  function wireDrag(el, fromOpen) {
    if (!el) return;
    el.addEventListener('touchstart', function (e) {
      beginDrag(e.touches[0].clientY, fromOpen);
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
      if (!drag) return;
      moveDrag(e.touches[0].clientY);
      e.preventDefault();     // hold the page still while dragging the sheet
    }, { passive: false });
    el.addEventListener('touchend', function (e) {
      if (!drag) return;
      endDrag();
      e.preventDefault();     // suppress the synthesized click after a touch
    }, { passive: false });
    // mouse / keyboard fallback (peek & the hamburger are real buttons)
    el.addEventListener('click', function () {
      if (drag) return;
      setOpen(fromOpen ? false : true);
    });
  }
  wireDrag(peek, false);   // closed -> drag up / tap to open
  wireDrag(grab, true);    // open   -> drag down / tap to close

  window.PreviewNav = {
    open: openNav,
    close: closeNav,
    toggle: toggleNav,
    isMobile: isMobile
  };

  // Initial state: with no file in the pane, show the navigator; deep-linking
  // to a file (a URL path not ending in "/", or a legacy ?view=) leaves it
  // folded so the content is what you land on.
  var hasView = new URLSearchParams(location.search).get('view') ||
                location.pathname.slice(-1) !== '/';
  if (isMobile() && !hasView) setOpen(true);
  else apply();
})();
