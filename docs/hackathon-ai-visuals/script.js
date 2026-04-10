(function() {
  function go(href) {
    if (!href) return;
    window.location.href = href;
  }

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    const prev = document.body.getAttribute('data-prev');
    const next = document.body.getAttribute('data-next');
    if (e.key === 'ArrowLeft' && prev) go(prev);
    if (e.key === 'ArrowRight' && next) go(next);
  });
})();
