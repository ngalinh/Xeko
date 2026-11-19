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
  const candidates = [...scope.querySelectorAll('[data-testid="product-price"], [data-auto="price-sales"], [class*="price"], [class*="Price"]')]
    .filter(el => visible(el) && !el.closest('nav, footer, [class*="recommend"], [class*="similar"], [class*="carousel"]'));
  const texts = candidates.map(el => ({ el, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() }));
  // Macy's may show the original amount before "Now" in the same block.
  for (const { text } of texts) {
    const sale = text.match(/(?:sale|now|your price)\s*:?\s*((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)/i);
    if (sale) {
      const original = text.match(/(?:orig(?:inal)?\.?|regular|was)\s*:?\s*((?:US\s*)?\$\s*\d[\d,]*(?:\.\d{2})?)/i);
      const discount = text.match(/\d+(?:\.\d+)?%\s*off/i);
      return `Sale ${sale[1]}` + (original ? ` Orig. ${original[1]}` : '') + (discount ? ` ${discount[0]}` : '');
    }
  }
  for (const { el, text } of texts) {
    if (/sales?|discount|current|final/i.test(el.className + ' ' + el.getAttribute('data-auto')) && !/original|regular/i.test(el.className)) {
      const match = text.match(money);
      if (match) return match[0];
    }
  }
  for (const { text } of texts) {
    if (money.test(text)) return text;
  }
  return null;
};
