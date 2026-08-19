/* ==========================================================================
   gift-wrap.js

   Per-line gift wrapping on the cart page.

   The choice is stored as LINE ITEM PROPERTIES via /cart/change.js, not in
   localStorage or a hidden form. That means it survives reloads, follows the
   line through checkout, and appears on the order for whoever packs it — there
   is no second copy of the truth to drift.

   Every handler is delegated from `document`, because cart.js replaces the
   whole .js-contents block after each update and anything bound directly to a
   row would be thrown away with it.
   ========================================================================== */
(function () {
  'use strict';

  var MESSAGE_LIMIT = 200;

  var PROP_WRAP = 'Gift wrap';
  var PROP_MESSAGE = 'Gift message';
  /* Leading underscore: Shopify hides these from the cart, checkout and order
     emails, so the preview URL never shows up as a line of customer-facing
     text. */
  var PROP_IMAGE = '_gift_wrap_image';

  /* The line the modal is currently editing. Held here rather than on the DOM
     so a mid-flight section re-render cannot strand it. */
  var active = null;

  function modal() {
    return document.getElementById('GiftWrapModal');
  }

  function el(selector, root) {
    return (root || document).querySelector(selector);
  }

  /* ---------------------------------------------------------------------- */
  /* SECTION RE-RENDER                                                       */
  /* ---------------------------------------------------------------------- */

  /* Mirrors cart.js's own list so a gift-wrap save refreshes exactly what a
     quantity change refreshes — items, totals, the header bubble and the live
     region. Built defensively: the cart page has main-cart-items/-footer, the
     drawer does not, so missing hosts are skipped rather than throwing. */
  function sectionsToRender() {
    var out = [];
    var items = document.getElementById('main-cart-items');
    var footer = document.getElementById('main-cart-footer');

    if (items) out.push({ id: 'main-cart-items', section: items.dataset.id, selector: '.js-contents' });
    out.push({ id: 'cart-icon-bubble', section: 'cart-icon-bubble', selector: '.shopify-section' });
    out.push({
      id: 'cart-live-region-text',
      section: 'cart-live-region-text',
      selector: '.shopify-section'
    });
    if (footer) out.push({ id: 'main-cart-footer', section: footer.dataset.id, selector: '.js-contents' });

    return out;
  }

  function sectionInnerHTML(html, selector) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var found = doc.querySelector(selector);
    return found ? found.innerHTML : '';
  }

  function applySections(state) {
    if (!state || !state.sections) return;

    sectionsToRender().forEach(function (section) {
      var host = document.getElementById(section.id);
      if (!host) return;
      var target = host.querySelector(section.selector) || host;
      var html = state.sections[section.section];
      if (typeof html !== 'string') return;
      target.innerHTML = sectionInnerHTML(html, section.selector);
    });

    // Same empty-state bookkeeping cart.js does, so the cart page and drawer
    // do not get stuck showing an empty shell after the last item changes.
    var isEmpty = state.item_count === 0;
    ['cart-items', 'main-cart-footer'].forEach(function (id) {
      var node = id === 'cart-items' ? el('cart-items') : document.getElementById(id);
      if (node) node.classList.toggle('is-empty', isEmpty);
    });
    var drawer = el('cart-drawer');
    if (drawer) drawer.classList.toggle('is-empty', isEmpty);

    if (typeof window.publish === 'function' && window.PUB_SUB_EVENTS) {
      window.publish(window.PUB_SUB_EVENTS.cartUpdate, {
        source: 'gift-wrap',
        cartData: state
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* WRITE                                                                   */
  /* ---------------------------------------------------------------------- */

  /* Quantity is sent as-is on purpose: /cart/change.js treats a missing
     quantity inconsistently across payload shapes, and echoing the row's own
     value removes the ambiguity without ever changing what is in the cart. */
  function writeProperties(line, quantity, properties) {
    var url = (window.routes && window.routes.cart_change_url) || '/cart/change';

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/javascript',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        line: Number(line),
        quantity: Number(quantity),
        properties: properties,
        sections: sectionsToRender().map(function (s) {
          return s.section;
        }),
        sections_url: window.location.pathname
      })
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (state) {
        if (state && (state.status || state.errors)) {
          var message = state.description || state.message || 'Could not update this item.';
          throw new Error(typeof state.errors === 'string' ? state.errors : message);
        }
        applySections(state);
        return state;
      });
  }

  /* Always send all three keys, using '' for the ones that are not set.

     Shopify removes a line item property when its value is an empty string; an
     OMITTED key is ambiguous and may simply be left as it was. Sending the full
     set makes the outcome deterministic — in particular, unticking "personalise
     your gift" reliably drops a message that was saved earlier, instead of
     leaving it silently attached to the order. */
  function propertySet(wrapName, message, image) {
    var properties = {};
    properties[PROP_WRAP] = wrapName || '';
    properties[PROP_MESSAGE] = message || '';
    properties[PROP_IMAGE] = image || '';
    return properties;
  }

  function rowFor(line) {
    return el('[data-gift-wrap-row][data-line="' + line + '"]');
  }

  function setRowBusy(line, busy) {
    var row = rowFor(line);
    if (row) row.classList.toggle('is-busy', !!busy);
  }

  /* ---------------------------------------------------------------------- */
  /* MODAL                                                                  */
  /* ---------------------------------------------------------------------- */

  function messageParts() {
    var box = modal();
    if (!box) return {};
    return {
      toggle: el('[data-gift-wrap-message-toggle]', box),
      input: el('[data-gift-wrap-message]', box),
      count: el('[data-gift-wrap-count]', box),
      save: el('[data-gift-wrap-save]', box),
      error: el('[data-gift-wrap-error]', box)
    };
  }

  function updateCount() {
    var parts = messageParts();
    if (!parts.input || !parts.count) return;
    var left = MESSAGE_LIMIT - parts.input.value.length;
    parts.count.textContent = left + (left === 1 ? ' character left' : ' characters left');
  }

  function setMessageEnabled(on) {
    var parts = messageParts();
    if (!parts.input || !parts.toggle) return;
    parts.toggle.checked = !!on;
    parts.input.disabled = !on;
    if (!on) parts.input.value = '';
    updateCount();
  }

  function selectedWrap() {
    var box = modal();
    if (!box) return null;
    return el('input[name="gift_wrap_option"]:checked', box);
  }

  function refreshSaveState() {
    var parts = messageParts();
    if (!parts.save) return;
    // Nothing to save until a paper is chosen — the reference lets you submit
    // an empty selection, which writes a wrap with no name onto the order.
    parts.save.disabled = !selectedWrap();
  }

  function setError(message) {
    var parts = messageParts();
    if (parts.error) parts.error.textContent = message || '';
  }

  function openModal(line, quantity, preset) {
    var box = modal();
    if (!box) return;

    active = { line: line, quantity: quantity };
    setError('');

    // Pre-select whatever this line already has, matching on the visible name.
    var chosen = null;
    var radios = box.querySelectorAll('input[name="gift_wrap_option"]');
    radios.forEach(function (radio) {
      var match = preset.name && radio.value === preset.name;
      radio.checked = !!match;
      if (match) chosen = radio;
    });
    // A wrap that was removed from the theme since the shopper picked it leaves
    // nothing checked; fall back to the first option so Save is reachable.
    if (!chosen && !preset.name && radios.length) {
      radios[0].checked = true;
    }

    setMessageEnabled(!!preset.message);
    var parts = messageParts();
    if (parts.input && preset.message) {
      parts.input.value = preset.message.slice(0, MESSAGE_LIMIT);
      updateCount();
    }

    refreshSaveState();

    box.hidden = false;
    document.body.classList.add('overflow-hidden');

    var first = selectedWrap() || el('[data-gift-wrap-dismiss]', box);
    if (first && typeof first.focus === 'function') first.focus();
  }

  /* revert: when the shopper opened the modal by ticking a box and then backed
     out without saving, the tick has to come off again or the row claims a wrap
     the cart does not have. */
  function closeModal(revert) {
    var box = modal();
    if (!box) return;

    if (revert && active) {
      var checkbox = el('[data-gift-wrap-checkbox][data-line="' + active.line + '"]');
      if (checkbox && !checkbox.dataset.wrapName) checkbox.checked = false;
    }

    box.hidden = true;
    document.body.classList.remove('overflow-hidden');
    setError('');

    var line = active ? active.line : null;
    active = null;

    var checkboxToFocus = line && el('[data-gift-wrap-checkbox][data-line="' + line + '"]');
    if (checkboxToFocus && typeof checkboxToFocus.focus === 'function') checkboxToFocus.focus();
  }

  function save() {
    if (!active) return;

    var wrap = selectedWrap();
    if (!wrap) {
      setError('Please choose a wrapping paper.');
      return;
    }

    var parts = messageParts();
    var message = parts.input && !parts.input.disabled ? parts.input.value.trim() : '';
    var properties = propertySet(
      wrap.value,
      message.slice(0, MESSAGE_LIMIT),
      wrap.getAttribute('data-wrap-image')
    );

    var line = active.line;
    var quantity = active.quantity;

    if (parts.save) {
      parts.save.disabled = true;
      parts.save.classList.add('is-loading');
    }
    setRowBusy(line, true);
    setError('');

    writeProperties(line, quantity, properties)
      .then(function () {
        // closeModal(false): the row is genuinely wrapped now, so the tick stays.
        closeModal(false);
      })
      .catch(function (error) {
        setError(error && error.message ? error.message : 'Could not save. Please try again.');
        setRowBusy(line, false);
      })
      .finally(function () {
        if (parts.save) {
          parts.save.classList.remove('is-loading');
          refreshSaveState();
        }
      });
  }

  function removeWrap(line, quantity) {
    setRowBusy(line, true);
    writeProperties(line, quantity, propertySet('', '', '')).catch(function () {
      // Put the tick back — the cart still has the wrap on it.
      var checkbox = el('[data-gift-wrap-checkbox][data-line="' + line + '"]');
      if (checkbox) checkbox.checked = true;
      setRowBusy(line, false);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* EVENTS — all delegated, so re-rendered rows need no re-binding          */
  /* ---------------------------------------------------------------------- */

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target) return;

    if (target.matches('[data-gift-wrap-checkbox]')) {
      var line = target.getAttribute('data-line');
      var quantity = target.getAttribute('data-quantity') || 1;

      if (target.checked) {
        openModal(line, quantity, {
          name: target.getAttribute('data-wrap-name') || '',
          message: target.getAttribute('data-wrap-message') || ''
        });
      } else {
        removeWrap(line, quantity);
      }
      return;
    }

    if (target.matches('[data-gift-wrap-message-toggle]')) {
      setMessageEnabled(target.checked);
      if (target.checked) {
        var input = messageParts().input;
        if (input) input.focus();
      }
      return;
    }

    if (target.matches('input[name="gift_wrap_option"]')) {
      refreshSaveState();
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target && event.target.matches('[data-gift-wrap-message]')) updateCount();
  });

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    if (target.closest('[data-gift-wrap-dismiss]')) {
      event.preventDefault();
      closeModal(true);
      return;
    }

    if (target.closest('[data-gift-wrap-save]')) {
      event.preventDefault();
      save();
      return;
    }

    var edit = target.closest('[data-gift-wrap-edit]');
    if (edit) {
      event.preventDefault();
      var line = edit.getAttribute('data-line');
      var checkbox = el('[data-gift-wrap-checkbox][data-line="' + line + '"]');
      if (!checkbox) return;
      openModal(line, checkbox.getAttribute('data-quantity') || 1, {
        name: checkbox.getAttribute('data-wrap-name') || '',
        message: checkbox.getAttribute('data-wrap-message') || ''
      });
    }
  });

  document.addEventListener('keydown', function (event) {
    var box = modal();
    if (!box || box.hidden) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal(true);
      return;
    }

    /* Keep Tab inside the dialog. Without this the shopper tabs into the cart
       behind the overlay, where nothing is visible or clickable. */
    if (event.key !== 'Tab') return;

    var focusable = box.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
    );
    if (!focusable.length) return;

    var list = Array.prototype.filter.call(focusable, function (node) {
      return node.offsetWidth > 0 || node.offsetHeight > 0 || node === document.activeElement;
    });
    if (!list.length) return;

    var first = list[0];
    var last = list[list.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // The count label starts from Liquid, but a browser restoring a typed value
  // on back-navigation would leave it stale.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateCount);
  } else {
    updateCount();
  }
})();
