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

  var SLIDE_MS = 2600;
  var CARD_SELECTOR = '.card-wrapper[data-card-slider]';
  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var DESKTOP_QUERY = '(min-width: 750px)';
  var desktopMQ = window.matchMedia ? window.matchMedia(DESKTOP_QUERY) : null;

  function isDesktop() {
    return desktopMQ ? desktopMQ.matches : window.innerWidth >= 750;
  }

  function autoplayAllowed() {
    // Desktop is manual-only (arrows). Touch/mobile autoplays.
    return !reduceMotion && !isDesktop();
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
      if (card.__slider.timer) window.clearInterval(card.__slider.timer);
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

    urls.forEach(function (url, i) {
      var slide = document.createElement('div');
      slide.className = 'card-slider__slide';

      // Slide 0 is left EMPTY on purpose: Dawn's own <img> sits directly
      // beneath the transparent slider, so at rest the card looks exactly as
      // it always did and a failed CDN request can never blank the card.
      if (i > 0) {
        var img = document.createElement('img');
        img.className = 'card-slider__img';
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.addEventListener('error', function () {
          slide.classList.add('is-broken');
        });
        img.src = url;
        slide.appendChild(img);
      }

      track.appendChild(slide);
    });

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

    /* ARROWS GO OUTSIDE .card__media ON PURPOSE.
       `.ratio` is `display: flex`, so `.card__media` is a flex item — and a
       flex item carrying `z-index: 0` (Dawn's Safari border fix) creates a
       stacking context. Anything inside it is trapped below the stretched card
       link at z-index 1, which is why arrow clicks opened the product page.
       Mounting on `.card__inner` puts the controls in the same stacking context
       as the link, where a higher z-index actually wins. The controls are
       absolutely positioned in CSS so they do not become a flex sibling of the
       image (that squashed the card). */
    var host = card.querySelector('.card__inner') || media;

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

    function step(delta) {
      return function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (!card.__slider) return;
        pause(card.__slider, false);
        goTo(card.__slider, card.__slider.index + delta);
      };
    }

    [prev, next].forEach(function (btn) {
      btn.addEventListener('click', step(btn === prev ? -1 : 1));
      // Stop the press reaching the card link before the click even resolves.
      ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
        btn.addEventListener(
          evt,
          function (e) {
            e.preventDefault();
            e.stopPropagation();
          },
          { passive: false }
        );
      });
    });

    var state = {
      card: card,
      track: track,
      dots: dots.children,
      count: urls.length,
      index: 0,
      timer: null
    };

    card.__slider = state;
    return state;
  }

  function goTo(state, index) {
    if (!state) return;
    state.index = ((index % state.count) + state.count) % state.count;
    state.track.style.transform = 'translateX(-' + state.index * 100 + '%)';
    for (var i = 0; i < state.dots.length; i++) {
      state.dots[i].classList.toggle('is-active', i === state.index);
    }
  }

  function play(state) {
    // Desktop is manual-only: arrows drive the slider, nothing moves on its own.
    if (!autoplayAllowed()) return;
    if (!state || state.timer || state.count < 2) return;
    state.timer = window.setInterval(function () {
      goTo(state, state.index + 1);
    }, SLIDE_MS);
  }

  function pause(state, reset) {
    if (!state) return;
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
    if (reset) goTo(state, 0);
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

  function setupSlider(card) {
    if (card.__sliderBound) return;
    if (galleryUrls(card).length < 2) return;
    card.__sliderBound = true;

    if (sliderObserver) {
      sliderObserver.observe(card);
    } else {
      play(buildSlider(card));
    }

    card.addEventListener('mouseenter', function () {
      // Ensure the arrows are present the moment a pointer arrives.
      buildSlider(card);
      pause(card.__slider, false);
    });
    card.addEventListener('mouseleave', function () {
      play(card.__slider);
    });

    card.addEventListener(
      'touchstart',
      function () {
        if (isDesktop()) return;
        var s = buildSlider(card);
        if (s) goTo(s, s.index + 1);
      },
      { passive: true }
    );
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
