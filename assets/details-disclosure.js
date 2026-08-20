/* Written so a SECOND execution of this file is harmless.

   `class X` at the top level of a classic script creates a global lexical
   binding, and running the same file twice is a duplicate declaration —
   SyntaxError, thrown before any statement in the file runs, so no runtime
   check placed inside could ever prevent it. It showed up in this store's real
   traffic as "Can't create duplicate variable: 'CartDrawer'" and
   "...'DetailsDisclosure'", together about an eighth of all recorded JS errors.
   Nothing in the theme loads either file twice — the page HTML has exactly one
   tag for each — so the second run comes from the environment: in-app browsers
   (Instagram, Facebook) are most of this store's mobile sessions and some of
   them re-run deferred scripts.

   `var` was chosen over a block or an IIFE because the binding has to stay
   global: share.js does `class ShareButton extends
   DetailsDisclosure`, and cart-drawer.js reaches for CartItems from cart.js. Redeclaring a
   `var` is legal, and reading window.X first means the second run reuses the
   constructor the first run registered rather than building a rival one.

   The customElements.define calls are guarded for the same reason — defining a
   name twice throws NotSupportedError. */

var DetailsDisclosure =
  window.DetailsDisclosure ||
  class DetailsDisclosure extends HTMLElement {
  constructor() {
    super();
    this.mainDetailsToggle = this.querySelector('details');
    this.content = this.mainDetailsToggle.querySelector('summary').nextElementSibling;

    this.mainDetailsToggle.addEventListener('focusout', this.onFocusOut.bind(this));
    this.mainDetailsToggle.addEventListener('toggle', this.onToggle.bind(this));
  }

  onFocusOut() {
    setTimeout(() => {
      if (!this.contains(document.activeElement)) this.close();
    });
  }

  onToggle() {
    if (!this.animations) this.animations = this.content.getAnimations();

    if (this.mainDetailsToggle.hasAttribute('open')) {
      this.animations.forEach((animation) => animation.play());
    } else {
      this.animations.forEach((animation) => animation.cancel());
    }
  }

  close() {
    this.mainDetailsToggle.removeAttribute('open');
    this.mainDetailsToggle.querySelector('summary').setAttribute('aria-expanded', false);
  }
};

if (!customElements.get('details-disclosure')) {
  customElements.define('details-disclosure', DetailsDisclosure);
}

var HeaderMenu =
  window.HeaderMenu ||
  class HeaderMenu extends DetailsDisclosure {
  constructor() {
    super();
    this.header = document.querySelector('.header-wrapper');
  }

  onToggle() {
    if (!this.header) return;
    this.header.preventHide = this.mainDetailsToggle.open;

    if (document.documentElement.style.getPropertyValue('--header-bottom-position-desktop') !== '') return;
    document.documentElement.style.setProperty(
      '--header-bottom-position-desktop',
      `${Math.floor(this.header.getBoundingClientRect().bottom)}px`
    );
  }
};

if (!customElements.get('header-menu')) {
  customElements.define('header-menu', HeaderMenu);
}
