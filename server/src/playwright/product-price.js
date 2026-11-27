// Runs in the product page. Prefer the visible selling price over list prices,
// hidden mobile duplicates and prices in navigation/recommendations.
module.exports = function collectProductPrice() {
  const money = /(?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?/;
  const visible = el => {
    for (let node = el; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const scope = document.querySelector('#product-details, .product-details, [data-testid="product-details"]') || document.querySelector('main') || document.body;
  const candidates = [...scope.querySelectorAll('[data-testid="product-price"], [data-auto="price-sales"], [class*="price"], [class*="Price"], [data-auto="price-original"], del, s, strike')]
    .filter(el => visible(el) && !el.closest('nav, footer, [class*="recommend"], [class*="similar"], [class*="carousel"]'));
  const texts = candidates.map(el => ({ el, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }));
  const originalLabel = /(?:orig(?:inal)?\.?|regular|was)\s*:?\s*((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)/i;
  const isOriginal = el => /original|regular|list-price|price-list|strike/i.test(el.className + ' ' + el.getAttribute('data-auto'))
    || !!el.closest('del, s, strike') || /line-through/.test(window.getComputedStyle(el).textDecorationLine + ' ' + window.getComputedStyle(el).textDecoration);
  const labelledOriginal = texts.map(({ text }) => text.match(originalLabel)).find(Boolean);
  const originalElement = texts.find(({ el, text }) => isOriginal(el) && money.test(text));
  const original = labelledOriginal ? labelledOriginal[1] : originalElement?.text.match(money)[0];
  const formatSale = (sale, discount) => `Sale ${sale}` + (original ? ` Orig. ${original}` : '') + (discount ? ` ${discount}` : '');
  // Promo banners glue a label before the price and junk after it, e.g.
  // "BLACK FRIDAY DEAL$39.75 (50% off)$79.50Details" — pull out just the three values.
  const dealPattern = /((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)\s*\(\s*(\d+(?:\.\d+)?%\s*off)\s*\)\s*((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)/i;
  for (const { text } of texts) {
    const deal = text.match(dealPattern);
    if (deal) return `Sale ${deal[1]} Orig. ${deal[3]} ${deal[2].replace(/\s+/g, ' ')}`;
  }
  // Macy's may show the original amount before "Now" in the same block.
  for (const { text } of texts) {
    const sale = text.match(/(?:sale|now|your price)\s*:?\s*((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)/i);
    if (sale) {
      const discount = text.match(/\d+(?:\.\d+)?%\s*off/i);
      return formatSale(sale[1], discount?.[0]);
    }
  }
  for (const { el, text } of texts) {
    if (/sales?|discount|current|final/i.test(el.className + ' ' + el.getAttribute('data-auto')) && !isOriginal(el)) {
      const match = text.match(money);
      if (match) return original ? formatSale(match[0]) : match[0];
    }
  }
  // Last resort: some sites glue the price straight to unrelated promo copy
  // in the same element with no label/class hint at all (e.g. Tommy Hilfiger:
  // "$189.00 $94.50 50% off Hilfiger Club Exclusive: Extra 25% Off ... Sign Up
  // now!") — returning the raw innerText leaks that trailing text into the
  // saved price. Pull out just the money/percent figures instead of the text.
  for (const { text } of texts) {
    const moneyAll = text.match(new RegExp(money.source, 'g'));
    if (!moneyAll) continue;
    const discount = text.match(/\d+(?:\.\d+)?%\s*off/i);
    // Only compare the FIRST two figures: the real sale/orig pair sits at the
    // start, right next to each other; anything further in is unrelated
    // trailing promo copy (e.g. "...Extra 25% Off $225+ or 15% Off $175+...")
    // that must not be mistaken for the product's own original price.
    if (moneyAll.length >= 2) {
      const [a, b] = moneyAll.slice(0, 2).map(raw => ({ raw, value: parseFloat(raw.replace(/[^\d.]/g, '')) }));
      if (a.value !== b.value) {
        const sale = a.value <= b.value ? a : b;
        const orig = a.value <= b.value ? b : a;
        return `Sale ${sale.raw} Orig. ${orig.raw}` + (discount ? ` ${discount[0].replace(/\s+/g, ' ')}` : '');
      }
    }
    return moneyAll[0];
  }
  return null;
};
