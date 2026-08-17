/* ==========================================================================
   custom-fixes.js

     A. Auto-sliding product card image carousel (slide animation, all cards)
     B. ADD TO CART bar -> inline size popup -> AJAX add to cart

   Both are lazy: nothing is built or fetched until a card is on screen.
   ========================================================================== */
(function () {
  'use strict';

  /* ====================================================================== */
  /* A. CARD IMAGE SLIDER                                                    */
  /* ====================================================================== */

  /* How long each image is held before the next one slides in. The 0.7s
     transition runs inside this window, so the visible "rest" on each image is
     roughly SLIDE_MS minus 700ms. Raise it for a slower carousel. */
  var SLIDE_MS = 4800;

  /* After a manual swipe or arrow press, autoplay stays out of the way this
     long before taking over again. Previously a manual move killed autoplay
     permanently on touch (there is no mouseleave on a phone), so the carousel
     went dead after the first tap. */
  var RESUME_MS = 4500;

  /* Horizontal travel that turns a press into a swipe. Capped against the card
     width at the call site so narrow cards need proportionally less travel. */
  var SWIPE_MIN = 40;

  /* Movement needed before we commit to "this is a drag" at all, and the axis
     test that keeps vertical page scrolling working. */
  var DRAG_SLOP = 6;

  var CARD_SELECTOR = '.card-wrapper[data-card-slider]';
  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DESKTOP_QUERY = '(min-width: 750px)';
  var desktopMQ = window.matchMedia ? window.matchMedia(DESKTOP_QUERY) : null;

  function isDesktop() {
    return desktopMQ ? desktopMQ.matches : window.innerWidth >= 750;
  }

  /* Product pages keep their recommendation cards still. The shopper is already
     looking at one product, and a grid of thumbnails moving on its own below
     the gallery competes with the gallery they are actually using. Manual swipe
     and the desktop arrows still work there — only the timer is off.

     Read lazily rather than cached at parse time so it cannot depend on whether
     <body> existed when this file ran. */
  function isProductPage() {
    return !!(document.body && document.body.getAttribute('data-page-type') === 'product');
  }

  function autoplayAllowed() {
    // Desktop is manual-only (arrows). Touch/mobile autoplays.
    return !reduceMotion && !isDesktop() && !isProductPage();
  }

  var mounted = new WeakSet();
  var sliderObserver = null;

  var ARROW_PREV =
    '<svg viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M10.5 1.5L2 10l8.5 8.5" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ARROW_NEXT =
    '<svg viewBox="0 0 12 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M1.5 1.5L10 10l-8.5 8.5" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function galleryUrls(card) {
    var node = card.querySelector('script.card-gallery-data');
    if (node) {
      try {
        var parsed = JSON.parse(node.textContent);
        if (Array.isArray(parsed)) {
          return parsed.filter(function (u) {
            return typeof u === 'string' && u.length;
          });
        }
      } catch (e) {
        /* fall through */
      }
    }
    // Legacy attribute fallback.
    return (card.getAttribute('data-card-gallery') || '')
      .split('|')
      .map(function (u) {
        return u.trim();
      })
      .filter(Boolean);
  }

  function teardown(card) {
    card.classList.remove('has-slider');
    var existing = card.querySelector('.card-slider');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    if (card.__slider) {
      var state = card.__slider;
      if (state.timer) window.clearInterval(state.timer);
      if (state.resumeTimer) window.clearTimeout(state.resumeTimer);
      if (state.wrapTimer) window.clearTimeout(state.wrapTimer);
      card.__slider = null;
    }
  }

  function buildSlider(card) {
    if (mounted.has(card)) return card.__slider || null;

    var urls = galleryUrls(card);
    var media = card.querySelector('.card__media .media');
    if (!media || urls.length < 2) return null;

    mounted.add(card);

    var slider = document.createElement('div');
    slider.className = 'card-slider';
    slider.setAttribute('aria-hidden', 'true');

    var track = document.createElement('div');
    track.className = 'card-slider__track';

    /* EVERY slide carries a real <img> — including slide 0 and both clones.

       This is the fix for "the first image appears instead of sliding in". The
       earlier build left slide 0 blank on purpose and let Dawn's own <img> show
       through the transparent slider. But that <img> is NOT part of the track,
       so it could not move: every other slide animated across a picture that
       sat perfectly still, and looping back round to it read as a hard cut
       rather than a slide.

       Dawn's <img> still sits underneath as the safety net. A slide whose image
       404s gets .is-broken, turns transparent, and the product image shows
       through exactly as before — the card can still never render empty. */
    function makeSlide(url, eager) {
      var slide = document.createElement('div');
      slide.className = 'card-slider__slide';
      if (!url) return slide;

      var img = document.createElement('img');
      img.className = 'card-slider__img';
      img.alt = '';
      img.decoding = 'async';
      // The resting slide and its neighbour are on screen straight away.
      img.loading = eager ? 'eager' : 'lazy';
      img.addEventListener('error', function () {
        slide.classList.add('is-broken');
      });
      img.src = url;
      slide.appendChild(img);
      return slide;
    }

    /* INFINITE TRACK

       Layout: [ clone(last) ][ 0 ][ 1 ] ... [ n-1 ][ clone(0) ]

       Real slide i lives at track position i + 1, so the resting position is 1.

       The clones are what make the loop seamless. Advancing past the last real
       slide lands on clone(0); the moment that transition ends the track hops
       back to position 1 with transitions switched off, so the shopper never
       sees the rewind. Mirror image for the head clone when going backwards.

       Positions 1 and count + 1 hold the same picture, as do positions 0 and
       count. That is precisely what makes the hop between them invisible. */
    track.appendChild(makeSlide(urls[urls.length - 1], true));
    urls.forEach(function (url, i) {
      track.appendChild(makeSlide(url, i === 0));
    });
    track.appendChild(makeSlide(urls[0], false));

    card.classList.add('has-slider');

    var dots = document.createElement('div');
    dots.className = 'card-slider__dots';
    urls.forEach(function (_, i) {
      var dot = document.createElement('span');
      dot.className = 'card-slider__dot' + (i === 0 ? ' is-active' : '');
      dots.appendChild(dot);
    });

    slider.appendChild(track);
    slider.appendChild(dots);

    media.appendChild(slider);

    /* ARROWS ARE MOUNTED OUTSIDE .card-wrapper, ON THE GRID ITEM.

       Dawn's whole-card link is `.card__heading a::after`, stretched over
       .card-wrapper at z-index 1. Two earlier attempts to out-rank it from
       inside the card failed: inside .card__media the arrows are trapped
       (it is a flex item carrying z-index: 0, so it opens its own stacking
       context), and inside .card__inner the z-index did not win in practice.

       Mounting on the <li class="grid__item"> makes the arrows a LATER SIBLING
       of .card-wrapper in the same stacking context, with a higher z-index.
       Later sibling + higher z-index cannot be painted under — there is no
       stacking subtlety left to get wrong.

       The trade-off is that the controls no longer inherit the image box, so
       their height is mirrored from .card__inner with a ResizeObserver. */
    var inner = card.querySelector('.card__inner');
    var host = card.closest('.grid__item') || card.parentNode || inner || media;

    var controls = document.createElement('div');
    controls.className = 'card-slider__controls';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'card-slider__nav card-slider__nav--prev';
    prev.setAttribute('aria-label', 'Previous image');
    prev.innerHTML = ARROW_PREV;

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'card-slider__nav card-slider__nav--next';
    next.setAttribute('aria-label', 'Next image');
    next.innerHTML = ARROW_NEXT;

    controls.appendChild(prev);
    controls.appendChild(next);
    host.appendChild(controls);
    host.classList.add('has-card-slider');

    function syncControlsHeight() {
      var box = inner || media;
      if (!box) return;
      var h = box.offsetHeight;
      if (h > 0) controls.style.height = h + 'px';
    }

    syncControlsHeight();
    if ('ResizeObserver' in window && (inner || media)) {
      new ResizeObserver(syncControlsHeight).observe(inner || media);
    } else {
      window.addEventListener('resize', syncControlsHeight);
    }
    // Images finishing their load change the box height.
    window.addEventListener('load', syncControlsHeight);

    function step(delta) {
      return function (event) {
        event.preventDefault();
        event.stopPropagation();
        var s = card.__slider || buildSlider(card);
        if (!s) return;
        pauseFor(s);
        move(s, delta);
        scheduleResume(s);
      };
    }

    [prev, next].forEach(function (btn) {
      btn.addEventListener('click', step(btn === prev ? -1 : 1));
      /* stopPropagation only — NOT preventDefault. Calling preventDefault on
         pointerdown suppresses the follow-up click event in some browsers,
         which would stop the arrow working for a different reason. */
      ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
        btn.addEventListener(
          evt,
          function (e) {
            e.stopPropagation();
          },
          { passive: true }
        );
      });
    });

    /* Capture-phase backstop: cancel the link's default action before it can
       act, while the event is still travelling DOWN to the button.

       preventDefault() ONLY — never stopPropagation() here. Capture runs
       root -> target, so stopping propagation on this ancestor prevents the
       event from ever reaching the button, and the arrow silently does
       nothing. That is exactly what broke v14. */
    if (host && !host.__navCaptureBound) {
      host.__navCaptureBound = true;
      host.addEventListener(
        'click',
        function (event) {
          var btn = event.target && event.target.closest
            ? event.target.closest('.card-slider__nav')
            : null;
          if (!btn) return;
          event.preventDefault();
        },
        true
      );
    }

    var state = {
      card: card,
      track: track,
      dots: dots.children,
      count: urls.length,
      // Track position, NOT the real slide index. Real index = pos - 1.
      pos: 1,
      timer: null,
      resumeTimer: null,
      wrapTimer: null,
      dragging: false
    };

    /* Seamless wrap: the instant a clone finishes sliding in, hop to the
       matching real slide with transitions off. */
    track.addEventListener('transitionend', function (event) {
      if (event.target !== track || event.propertyName !== 'transform') return;
      normalise(state);
    });

    card.__slider = state;
    setPos(state, 1, false);
    syncDots(state);
    return state;
  }

  /* Move the track to an absolute position.

     animate:false is the seamless-wrap hop — the transition is switched off,
     the transform committed with a forced reflow, then transitions are handed
     back. The reflow is load-bearing: without it the browser coalesces both
     style writes into one frame and animates the hop, which is the rewind all
     over again. */
  function setPos(state, pos, animate) {
    if (!state) return;
    state.pos = pos;
    var track = state.track;
    if (!animate) track.style.transition = 'none';
    track.style.transform = 'translateX(' + -pos * 100 + '%)';
    if (!animate) {
      void track.offsetHeight;
      track.style.transition = '';
    }
  }

  function realIndex(state) {
    return (((state.pos - 1) % state.count) + state.count) % state.count;
  }

  function syncDots(state) {
    var active = realIndex(state);
    for (var i = 0; i < state.dots.length; i++) {
      state.dots[i].classList.toggle('is-active', i === active);
    }
  }

  /* If we are parked on a clone, jump to the real slide it duplicates. */
  function normalise(state) {
    if (!state) return;
    if (state.pos === 0) setPos(state, state.count, false);
    else if (state.pos === state.count + 1) setPos(state, 1, false);
  }

  /* Relative move — the only way slides advance. Positions 0 and count + 1 are
     the clones and are legal here; normalise() snaps them back afterwards. */
  function move(state, delta) {
    if (!state || state.count < 2) return;

    /* Normalise BEFORE applying the delta.

       Both things that would otherwise do it — transitionend and the wrapTimer
       — run later than the next possible move. So a shopper swiping two or
       three times in quick succession added delta on top of a clone position
       and walked straight off the end of the track: pos became count + 2 and
       beyond, where no slides exist. The track went blank and the carousel
       looked stuck on the first image.

       Hopping to the clone's real twin first keeps pos inside 0..count + 1 no
       matter how fast the swipes arrive. The hop is invisible because a clone
       and its twin hold the same picture. */
    normalise(state);
    setPos(state, state.pos + delta, true);
    syncDots(state);

    /* transitionend normally does the wrap, but it never fires when motion is
       reduced (no transition to end) or if the tab is backgrounded mid-slide.
       This timer is the backstop; it is idempotent when transitionend already
       ran, because normalise() only acts on clone positions. */
    if (state.wrapTimer) window.clearTimeout(state.wrapTimer);
    state.wrapTimer = window.setTimeout(
      function () {
        state.wrapTimer = null;
        normalise(state);
      },
      // Comfortably after the 0.7s transition so this never races transitionend.
      reduceMotion ? 0 : 950
    );
  }

  function play(state) {
    // Desktop is manual-only: arrows drive the slider, nothing moves on its own.
    if (!autoplayAllowed()) return;
    if (!state || state.timer || state.count < 2) return;
    state.timer = window.setInterval(function () {
      // Never yank the track out from under a finger.
      if (state.dragging) return;
      move(state, 1);
    }, SLIDE_MS);
  }

  /* Stop autoplay AND any pending resume. Called the moment a shopper touches
     the card so the timer cannot fire mid-gesture. */
  function pauseFor(state) {
    if (!state) return;
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    if (state.resumeTimer) {
      window.clearTimeout(state.resumeTimer);
      state.resumeTimer = null;
    }
  }

  /* Hand autoplay back once the shopper has been idle for RESUME_MS. */
  function scheduleResume(state) {
    if (!state || !autoplayAllowed()) return;
    if (state.resumeTimer) window.clearTimeout(state.resumeTimer);
    state.resumeTimer = window.setTimeout(function () {
      state.resumeTimer = null;
      play(state);
    }, RESUME_MS);
  }

  function pause(state, reset) {
    if (!state) return;
    pauseFor(state);
    if (reset) {
      setPos(state, 1, false);
      syncDots(state);
    }
  }

  function createSliderObserver() {
    if (!('IntersectionObserver' in window)) return null;
    return new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var card = entry.target;
          if (entry.isIntersecting) {
            // Mount either way so the arrows exist; play() no-ops on desktop.
            play(buildSlider(card));
          } else if (card.__slider) {
            pause(card.__slider, autoplayAllowed());
          }
        });
      },
      { rootMargin: '200px 0px', threshold: 0.01 }
    );
  }

  /* POINTER DRAG — "manual" without needing the arrows.

     The listeners live on the card, not on .card-slider, because the slider is
     pointer-events: none so the whole-card link keeps working — which means the
     slider itself never receives a pointer event. Anything landing on the image
     or on Dawn's stretched link overlay bubbles up to the card either way.

     A press only becomes a drag once it has travelled DRAG_SLOP px AND moved
     further horizontally than vertically, so vertical page scrolling is
     untouched. If the gesture turns out to be vertical we bail out for good on
     that press. */
  function bindDrag(card) {
    var startX = 0;
    var startY = 0;
    var dx = 0;
    var width = 1;
    var active = false;
    var decided = false;
    var dragging = false;
    var suppressClick = false;
    var pointerId = null;

    card.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      var state = card.__slider || buildSlider(card);
      if (!state || state.count < 2) return;
      active = true;
      decided = false;
      dragging = false;
      dx = 0;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      width = card.offsetWidth || 1;
      pauseFor(state);
    });

    card.addEventListener(
      'pointermove',
      function (event) {
        if (!active) return;
        var state = card.__slider;
        if (!state) return;

        var mx = event.clientX - startX;
        var my = event.clientY - startY;

        if (!decided) {
          if (Math.abs(mx) < DRAG_SLOP && Math.abs(my) < DRAG_SLOP) return;
          decided = true;
          dragging = Math.abs(mx) > Math.abs(my);
          if (!dragging) {
            // Vertical gesture — hand it back to the page scroller.
            active = false;
            return;
          }
          state.dragging = true;

          /* Capture now that we own the gesture, so a finger that slides off
             the card (easy on a 2-up grid) keeps delivering move and up events
             here instead of silently stranding the drag. Captured only once
             the axis is settled — capturing on pointerdown would interfere
             with the browser's own vertical scrolling. */
          if (pointerId !== null && card.setPointerCapture) {
            try {
              card.setPointerCapture(pointerId);
            } catch (e) {
              /* Safari throws if the pointer is already gone; harmless. */
            }
          }
        }

        // Track follows the finger 1:1 while the drag is live.
        dx = mx;
        state.track.style.transition = 'none';
        state.track.style.transform =
          'translateX(calc(' + -state.pos * 100 + '% + ' + dx + 'px))';
      },
      { passive: true }
    );

    function release() {
      if (!active) return;
      active = false;
      var state = card.__slider;
      if (!state) return;

      if (dragging) {
        state.track.style.transition = '';
        state.dragging = false;

        // Narrow cards need proportionally less travel than a flat 40px.
        var threshold = Math.min(SWIPE_MIN, width * 0.18);
        if (Math.abs(dx) > threshold) move(state, dx < 0 ? 1 : -1);
        else setPos(state, state.pos, true); // snap back, gesture too small

        /* The browser still fires a click after the drag; swallow it so a swipe
           does not also navigate to the product page. */
        suppressClick = true;
        window.setTimeout(function () {
          suppressClick = false;
        }, 80);
      }

      if (pointerId !== null && card.releasePointerCapture) {
        try {
          card.releasePointerCapture(pointerId);
        } catch (e) {
          /* Already released. */
        }
      }
      pointerId = null;
      dx = 0;
      dragging = false;
      scheduleResume(state);
    }

    /* NOT pointerleave: on a 2-up grid the finger crosses the card edge
       constantly mid-swipe, and ending the drag there truncated it. Pointer
       capture above keeps up/cancel coming to us wherever the finger ends. */
    ['pointerup', 'pointercancel'].forEach(function (evt) {
      card.addEventListener(evt, release);
    });

    card.addEventListener(
      'click',
      function (event) {
        if (!suppressClick) return;
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  }

  function setupSlider(card) {
    if (card.__sliderBound) return;
    if (galleryUrls(card).length < 2) return;
    card.__sliderBound = true;

    if (sliderObserver) {
      sliderObserver.observe(card);
    } else {
      play(buildSlider(card));
    }

    /* Cards sitting inside one of Dawn's horizontal carousels must not fight it
       for horizontal gestures — that carousel owns them. Arrows still work. */
    var inCarousel = !!(
      card.closest && card.closest('.slider--mobile, .slider--tablet, slider-component')
    );

    if (!inCarousel) {
      /* touch-action goes on the CARD, not on .card__media.

         A browser resolves the effective touch-action for a gesture by walking
         up from the element actually under the finger. On these cards that
         element is Dawn's stretched link overlay (.card__heading a::after),
         which lives in .card__content — it is NOT inside .card__media. So
         setting pan-y on .card__media never applied to the touch that matters:
         the gesture kept its default of `auto`, the browser claimed it as a
         scroll and fired pointercancel, and the swipe died before it started.

         On the card it covers every descendant. Vertical scrolling stays
         native; the horizontal axis becomes ours. */
      card.style.touchAction = 'pan-y';
      bindDrag(card);
    }

    card.addEventListener('mouseenter', function () {
      // Ensure the arrows are present the moment a pointer arrives.
      buildSlider(card);
      pauseFor(card.__slider);
    });
    card.addEventListener('mouseleave', function () {
      play(card.__slider);
    });
  }

  /* ====================================================================== */
  /* B. SIZE POPUP + AJAX ADD TO CART                                        */
  /* ====================================================================== */

  var openPopup = null;

  function liftCard(popup, on) {
    var item = popup.closest('.grid__item');
    if (item) item.classList.toggle('sizes-open', !!on);
  }

  function closePopup() {
    if (!openPopup) return;
    openPopup.popup.hidden = true;
    liftCard(openPopup.popup, false);
    if (openPopup.toggle) openPopup.toggle.setAttribute('aria-expanded', 'false');
    openPopup = null;
  }

  function setStatus(popup, message, state) {
    if (!popup || !popup.querySelector) return;
    var el = popup.querySelector('.card-sizes__status, .card__sizes-status');
    if (!el) return;
    el.textContent = message || '';
    if (state) {
      el.setAttribute('data-state', state);
    } else {
      el.removeAttribute('data-state');
    }
  }

  function cartSections() {
    var drawer = document.querySelector('cart-drawer');
    if (drawer && typeof drawer.getSectionsToRender === 'function') {
      return drawer
        .getSectionsToRender()
        .map(function (s) {
          return s.id;
        })
        .join(',');
    }
    return 'cart-icon-bubble';
  }

  function refreshCart(json) {
    var drawer = document.querySelector('cart-drawer');
    if (drawer && typeof drawer.renderContents === 'function' && json.sections) {
      drawer.renderContents(json);
      return true;
    }

    var notification = document.querySelector('cart-notification');
    if (notification && typeof notification.renderContents === 'function' && json.sections) {
      notification.renderContents(json);
      return true;
    }

    // No drawer or notification component available — refresh the bubble only.
    if (json.sections && json.sections['cart-icon-bubble']) {
      var bubble = document.getElementById('cart-icon-bubble');
      if (bubble) {
        var parsed = new DOMParser()
          .parseFromString(json.sections['cart-icon-bubble'], 'text/html')
          .querySelector('.shopify-section');
        if (parsed) bubble.innerHTML = parsed.innerHTML;
      }
    }
    return false;
  }

  function addToCart(variantId, button, popup) {
    if (!variantId) return Promise.resolve();
    button.classList.add('is-loading');
    setStatus(popup, '');

    var body = {
      items: [{ id: Number(variantId), quantity: 1 }],
      sections: cartSections(),
      sections_url: window.location.pathname
    };

    var url = (window.routes && window.routes.cart_add_url) || '/cart/add';

    return fetch(url + '.js', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/javascript'
      },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (json) {
        if (json.status) {
          setStatus(popup, json.description || json.message || 'Could not add to cart.', 'error');
          return;
        }
        refreshCart(json);
        if (typeof window.publish === 'function' && window.PUB_SUB_EVENTS) {
          window.publish(window.PUB_SUB_EVENTS.cartUpdate, {
            source: 'card-size-popup',
            productVariantId: variantId,
            cartData: json
          });
        }
        closePopup();
      })
      .catch(function () {
        setStatus(popup, 'Network error. Please try again.', 'error');
      })
      .finally(function () {
        button.classList.remove('is-loading');
      });
  }

  function setupInlineSizes(card) {
    var group = card.querySelector('.card__sizes--interactive');
    if (!group || group.__bound) return;
    group.__bound = true;

    var status = card.querySelector('.card__sizes-status');
    var host = status && status.parentNode ? status.parentNode : card;

    group.querySelectorAll('.card__size--button').forEach(function (chip) {
      var handler = function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (chip.disabled || chip.classList.contains('is-loading')) return;

        var variantId = chip.getAttribute('data-variant-id');
        if (!variantId) return;

        addToCart(variantId, chip, host).then(function () {
          chip.classList.add('is-added');
          window.setTimeout(function () {
            chip.classList.remove('is-added');
          }, 1400);
        });
      };

      // Capture the press early so the stretched card link never wins the tap.
      chip.addEventListener('click', handler);
      chip.addEventListener('pointerdown', function (event) {
        event.stopPropagation();
      });
    });
  }

  function setupSizePopup(card) {
    var toggle = card.querySelector('.card-sizes__toggle');
    var popup = card.querySelector('.card-sizes');
    if (!toggle || !popup || toggle.__bound) return;
    toggle.__bound = true;

    toggle.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var isOpen = openPopup && openPopup.popup === popup;
      closePopup();
      if (isOpen) return;
      popup.hidden = false;
      liftCard(popup, true);
      toggle.setAttribute('aria-expanded', 'true');
      openPopup = { popup: popup, toggle: toggle };
      var first = popup.querySelector('.card-sizes__option:not([disabled])');
      if (first) first.focus();
    });

    var close = popup.querySelector('.card-sizes__close');
    if (close) {
      close.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
      });
    }

    popup.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    popup.querySelectorAll('.card-sizes__option').forEach(function (option) {
      option.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (option.disabled) return;
        addToCart(option.getAttribute('data-variant-id'), option, popup);
      });
    });
  }

  document.addEventListener('click', function () {
    closePopup();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closePopup();
  });

  // A card popup must never linger under an opening drawer.
  ['click', 'focusin'].forEach(function (evt) {
    document.addEventListener(
      evt,
      function (event) {
        var t = event.target;
        if (!t || !t.closest) return;
        if (t.closest('header-drawer, cart-drawer, .header__icon--cart, #cart-icon-bubble')) {
          closePopup();
        }
      },
      true
    );
  });


  /* ====================================================================== */
  /* C. MENU DRAWER — reliable close + correct top offset                    */
  /* ====================================================================== */

  var CLOSE_ICON =
    '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M1 1l16 16M17 1L1 17" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round"/></svg>';

  function headerSection() {
    return document.querySelector('.section-header');
  }

  /* Dawn writes --header-bottom-position from getBoundingClientRect().bottom,
     which can come back 0 on a transparent/absolute header or before layout
     settles. A 0 there put the drawer over the header and hid the X. Measure
     it ourselves and publish --drawer-top. */
  function syncDrawerTop() {
    var header = headerSection();
    if (!header) return;

    var rect = header.getBoundingClientRect();
    var top = Math.round(rect.bottom);

    if (!top || top < 1) {
      var inner = header.querySelector('.header');
      top = inner ? Math.round(inner.getBoundingClientRect().height) : 0;
    }
    if (!top || top < 1) top = 56;

    document.documentElement.style.setProperty('--drawer-top', top + 'px');
    document.documentElement.style.setProperty('--viewport-height', window.innerHeight + 'px');
  }

  function closeDrawer(event) {
    var drawer = document.querySelector('header-drawer');
    if (!drawer) return;

    var details = drawer.querySelector('#Details-menu-drawer-container') ||
      drawer.querySelector('details');
    var summary = details ? details.querySelector('summary') : null;

    // Full teardown: removes .menu-opening, .menu-open and the body scroll
    // lock. Calling closeSubmenu() alone would leave the page frozen.
    if (typeof drawer.closeMenuDrawer === 'function' && summary) {
      drawer.closeMenuDrawer(event || new Event('click'), summary);
      return;
    }
    if (summary) summary.click();
  }

  function injectDrawerDismiss() {
    var container = document.querySelector('header-drawer .menu-drawer__inner-container');
    if (!container || container.querySelector('.menu-drawer__dismiss')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'menu-drawer__dismiss';
    btn.setAttribute('aria-label', 'Close menu');
    btn.innerHTML = '<span>Close</span><span class="svg-wrapper">' + CLOSE_ICON + '</span>';

    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      closeDrawer(event);
    });

    container.insertBefore(btn, container.firstChild);
  }

  function watchDrawer() {
    var header = headerSection();
    if (!header) return;

    syncDrawerTop();
    injectDrawerDismiss();

    // Re-measure the moment the drawer opens, after Dawn has done its own pass.
    new MutationObserver(function () {
      if (header.classList.contains('menu-open')) {
        syncDrawerTop();
        window.requestAnimationFrame(syncDrawerTop);
        injectDrawerDismiss();
      }
    }).observe(header, { attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', syncDrawerTop);
    window.addEventListener('orientationchange', function () {
      window.setTimeout(syncDrawerTop, 150);
    });
  }

  /* ====================================================================== */
  /* INIT                                                                    */
  /* ====================================================================== */

  function init(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(CARD_SELECTOR).forEach(setupSlider);
    scope.querySelectorAll('.card-wrapper').forEach(setupSizePopup);
    scope.querySelectorAll('.card-wrapper').forEach(setupInlineSizes);
  }

  function onBreakpointChange() {
    document.querySelectorAll(CARD_SELECTOR).forEach(function (card) {
      if (!card.__slider) return;
      if (autoplayAllowed()) {
        play(card.__slider);
      } else {
        pause(card.__slider, false);
      }
    });
  }

  function boot() {
    sliderObserver = createSliderObserver();
    init(document);
    watchDrawer();

    if (desktopMQ) {
      if (desktopMQ.addEventListener) {
        desktopMQ.addEventListener('change', onBreakpointChange);
      } else if (desktopMQ.addListener) {
        desktopMQ.addListener(onBreakpointChange);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  document.addEventListener('shopify:section:load', function (event) {
    init(event.target || document);
    watchDrawer();
  });

  // Collection filters / pagination replace the grid without a page load.
  if ('MutationObserver' in window) {
    var watch = function () {
      var grid = document.getElementById('product-grid');
      if (!grid) return;
      new MutationObserver(function () {
        init(grid);
      }).observe(grid, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', watch);
    } else {
      watch();
    }
  }
})();
