/* ==========================================================================
   gift-wrap.js

   Per-line gift wrapping on the cart page, plus the charge that goes with it.

   TWO PIECES OF STATE, BOTH SERVER-SIDE
   -------------------------------------
   1. The choice itself is stored as LINE ITEM PROPERTIES via /cart/change.js —
      not in localStorage or a hidden form. It survives reloads, follows the
      line through checkout, and appears on the order for whoever packs it.

   2. The money is a real cart line. Shopify totals come from line items alone,
      so a fee cannot be conjured from a property or an attribute: charging for
      wrapping means keeping a line of the configured "gift wrap" product in the
      cart, at a quantity equal to the number of wrapped items. That line is
      derived, never authored — `syncFee` recomputes it from the cart every time
      the cart changes.

   Because both live in the cart, a refresh restores everything and there is no
   second copy of the truth to drift.

   Every handler is delegated from `document`, because cart.js replaces the
   whole .js-contents block after each update and anything bound directly to a
   row would be thrown away with it.

   LOADED ON EVERY TEMPLATE, not just the cart page. The picker half only has
   anything to bind to on /cart, but the charge half has to run wherever the
   cart can change — the drawer's remove button and quantity stepper are on
   every page, and either can leave the charge standing for an item that is no
   longer in the cart. What it needs to do that comes from #GiftWrapConfig,
   which snippets/gift-wrap-config.liquid renders sitewide.
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

  /* Guards against overlapping reconciles — a burst of quantity changes fires
     one cartUpdate each, and two syncs racing would both read a pre-write cart
     and write the same quantity twice. */
  var reconciling = false;

  function modal() {
    return document.getElementById('GiftWrapModal');
  }

  /* Present on every template, unlike the modal, which only the cart page
     renders. That is deliberate: the charge has to be maintained wherever the
     cart can be changed, and the drawer's remove button is everywhere. */
  function config() {
    return document.getElementById('GiftWrapConfig');
  }

  function el(selector, root) {
    return (root || document).querySelector(selector);
  }

  /* constants.js declares PUB_SUB_EVENTS with `const`, which creates a
     script-scope binding and NOT a property on window — so window.PUB_SUB_EVENTS
     is undefined and testing for it silently disables every publish. The bare
     identifier does resolve, via the shared global lexical environment, and
     typeof keeps it safe if constants.js is ever dropped. */
  function pubSubEvents() {
    return typeof PUB_SUB_EVENTS !== 'undefined' ? PUB_SUB_EVENTS : null;
  }

  function route(key, fallback) {
    return (window.routes && window.routes[key]) || fallback;
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

    /* Same empty-state bookkeeping cart.js does, so the cart page and drawer do
       not get stuck showing an empty shell after the last item changes. Guarded
       on the field being present: /cart/add.js answers with the added line, not
       the whole cart, and has no item_count to read. */
    if (typeof state.item_count === 'number') {
      var isEmpty = state.item_count === 0;
      ['cart-items', 'main-cart-footer'].forEach(function (id) {
        var node = id === 'cart-items' ? el('cart-items') : document.getElementById(id);
        if (node) node.classList.toggle('is-empty', isEmpty);
      });
      var drawer = el('cart-drawer');
      if (drawer) drawer.classList.toggle('is-empty', isEmpty);
    }

    /* Announcing the change is what keeps the header drawer's own copy of the
       cart in step — cart.js listens for this and re-renders itself. */
    var events = pubSubEvents();
    if (typeof window.publish === 'function' && events) {
      window.publish(events.cartUpdate, { source: 'gift-wrap', cartData: state });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* CART REQUESTS                                                           */
  /* ---------------------------------------------------------------------- */

  /* Resolves with the cart state and renders NOTHING. Callers decide when to
     paint, so a two-request flow (write the property, then correct the charge)
     updates the page once at the end instead of flashing an intermediate cart
     that has the wrap but not yet the fee. */
  function cartPost(url, payload) {
    payload.sections = sectionsToRender().map(function (s) {
      return s.section;
    });
    payload.sections_url = window.location.pathname;

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/javascript',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (state) {
        if (state && (state.status || state.errors)) {
          var message = state.description || state.message || 'Could not update the cart.';
          throw new Error(typeof state.errors === 'string' ? state.errors : message);
        }
        return state;
      });
  }

  /* Quantity is sent as-is on purpose: /cart/change.js treats a missing
     quantity inconsistently across payload shapes, and echoing the row's own
     value removes the ambiguity without ever changing what is in the cart. */
  function writeProperties(line, quantity, properties) {
    return cartPost(route('cart_change_url', '/cart/change'), {
      line: Number(line),
      quantity: Number(quantity),
      properties: properties
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

  /* ---------------------------------------------------------------------- */
  /* THE CHARGE                                                              */
  /* ---------------------------------------------------------------------- */

  /* null when the merchant has not picked a charge product — wrapping is then
     simply free, and nothing below runs. */
  function feeVariantId() {
    var box = config();
    if (!box) return null;
    var id = Number(box.getAttribute('data-fee-variant'));
    return id > 0 ? id : null;
  }

  function isWrapped(item) {
    var properties = item && item.properties;
    return !!(properties && properties[PROP_WRAP]);
  }

  /* One charge per wrapped UNIT, not per wrapped line: a line of three shirts
     marked for wrapping is three parcels to wrap. Read from the cart JSON
     rather than the checkboxes, so it does not depend on the DOM having already
     caught up with the write that just happened. */
  function wrappedUnits(state, feeId) {
    var total = 0;
    (state.items || []).forEach(function (item) {
      if (item.variant_id === feeId) return;
      if (isWrapped(item)) total += item.quantity;
    });
    return total;
  }

  function feeLine(state, feeId) {
    var found = null;
    (state.items || []).forEach(function (item) {
      if (!found && item.variant_id === feeId) found = item;
    });
    return found;
  }

  /* Brings the charge line into step with the wraps and resolves with
     { state, changed }. `changed` is false when the cart was already correct,
     which is the common case — the caller can then skip a pointless re-render.

     The fee line is added with no properties so Shopify merges it with any
     existing line of the same variant. That keeps it a single line, which is
     what lets one change.js call set the whole charge. */
  function syncFee(state) {
    var feeId = feeVariantId();
    if (!feeId) return Promise.resolve({ state: state, changed: false });

    var wanted = wrappedUnits(state, feeId);
    var line = feeLine(state, feeId);
    var have = line ? line.quantity : 0;

    if (have === wanted) return Promise.resolve({ state: state, changed: false });

    var request = line
      ? cartPost(route('cart_change_url', '/cart/change'), { id: line.key, quantity: wanted })
      : cartPost(route('cart_add_url', '/cart/add') + '.js', { id: feeId, quantity: wanted });

    return request.then(function (updated) {
      return { state: updated, changed: true };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* RECONCILE                                                               */
  /* ---------------------------------------------------------------------- */

  /* Removing a wrapped item, or changing its quantity, goes through Dawn's own
     cart code and never touches this file — so the charge would be left over-
     or under-stated. Re-deriving it from the cart covers every one of those
     paths without having to hook each of them individually.

     `state` is the caller's copy of the cart when it has one; most of Dawn's
     cart code publishes the full change.js response, and reusing it saves a
     round trip. Omit it and the cart is read fresh. */
  function reconcile(state) {
    if (!feeVariantId() || reconciling) return Promise.resolve();
    reconciling = true;

    var read = state
      ? Promise.resolve(state)
      : fetch(route('cart_url', '/cart') + '.js', {
          headers: { Accept: 'application/json' }
        }).then(function (res) {
          return res.json();
        });

    return read
      .then(syncFee)
      .then(function (result) {
        if (result.changed) applySections(result.state);
      })
      .catch(function (error) {
        // Nothing the shopper can act on; the next cart change tries again.
        console.error('[gift-wrap] could not reconcile the gift wrap charge', error);
      })
      .finally(function () {
        reconciling = false;
      });
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

    var wrapWritten = false;

    writeProperties(line, quantity, properties)
      .then(function (state) {
        wrapWritten = true;
        return syncFee(state);
      })
      .then(function (result) {
        applySections(result.state);
        // closeModal(false): the row is genuinely wrapped now, so the tick stays.
        closeModal(false);
      })
      .catch(function (error) {
        /* The charge failed after the wrap was written — most likely the fee
           product is out of stock or unpublished. Take the wrap back off rather
           than leave a cart that says "gift wrapped" and charges nothing. */
        if (wrapWritten) {
          writeProperties(line, quantity, propertySet('', '', ''))
            .then(applySections)
            .catch(function () {
              /* Both writes failed; a reload is the only honest recovery, and
                 the shopper is about to be told to try again anyway. */
            });
        }
        setError(
          error && error.message ? error.message : 'Could not save this. Please try again.'
        );
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

    writeProperties(line, quantity, propertySet('', '', ''))
      .then(syncFee)
      .then(function (result) {
        applySections(result.state);
      })
      .catch(function () {
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

  /* ---------------------------------------------------------------------- */
  /* INIT                                                                    */
  /* ---------------------------------------------------------------------- */

  /* Move the dialog to <body>.

     A fixed-position modal is only reliably on top if no ancestor opens a
     stacking context. The Liquid already renders it outside <cart-items> (which
     carries Dawn's `.isolate`), but any wrapper added later — a transform, a
     filter, another `isolation: isolate` — would trap it again and let page
     content paint over it. Re-parenting to <body> removes the whole class of
     bug rather than chasing each instance.

     The theme editor re-renders sections, which would inject a second copy, so
     any previous one is discarded first. */
  function relocateModal() {
    var box = modal();
    if (!box || box.parentNode === document.body) return;

    document.querySelectorAll('body > #GiftWrapModal').forEach(function (stale) {
      if (stale !== box) stale.remove();
    });

    document.body.appendChild(box);
  }

  /* Liquid has already counted both sides of the charge for this render, so the
     usual case — they agree — costs no request at all. They disagree only when
     the cart was changed by something that does not know about wrapping, and
     then it is worth the round trip to put the total right before the shopper
     reads it. */
  function reconcileIfStale() {
    var box = config();
    if (!box) return;
    var current = Number(box.getAttribute('data-fee-current')) || 0;
    var needed = Number(box.getAttribute('data-fee-needed')) || 0;
    if (current !== needed) reconcile();
  }

  var subscribed = false;

  function init() {
    relocateModal();
    // The count starts from Liquid, but a browser restoring a typed value on
    // back-navigation would leave it stale.
    updateCount();
    reconcileIfStale();

    if (subscribed || typeof window.subscribe !== 'function') return;
    var events = pubSubEvents();
    if (!events) return;

    // Quantity changes and removals from Dawn's own cart controls land here.
    window.subscribe(events.cartUpdate, function (event) {
      if (!event || event.source === 'gift-wrap') return;

      var data = event.cartData;
      /* A payload without an `items` array is /cart/add.js answering with the
         line it just added, not the whole cart. Nothing the charge depends on
         can have moved: add merges on properties as well as variant, so a plain
         add never lands on a wrapped line. Skipping these keeps every
         add-to-cart on the site from costing an extra request. */
      if (data && !Array.isArray(data.items)) return;

      reconcile(data || undefined);
    });
    subscribed = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Theme editor: a re-rendered cart section brings a fresh modal with it.
  document.addEventListener('shopify:section:load', init);
})();
