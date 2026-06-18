/**
 * Language toggle module — manages the active editing language (ES / EN).
 * Other modules listen to the 'langchange' event on document to react.
 */

let currentLang = 'es';

/** Get the current active language */
export function getLang() {
  return currentLang;
}

/** Toggle between 'es' and 'en' */
export function toggleLang() {
  currentLang = currentLang === 'es' ? 'en' : 'es';
  document.dispatchEvent(new CustomEvent('langchange', { detail: currentLang }));
  updateToggleUI();
}

/** Get text from a bilingual text object for the active language */
export function t(textObj) {
  if (!textObj) return '';
  if (typeof textObj === 'string') return textObj; // legacy compat
  return textObj[currentLang] || '';
}

/** Get a placeholder hint when text is missing for current lang */
export function tPlaceholder(textObj) {
  if (!textObj) return '';
  const other = currentLang === 'es' ? 'en' : 'es';
  if (textObj[currentLang]) return '';
  if (textObj[other]) return `[${other.toUpperCase()}] ${textObj[other]}`;
  return '';
}

/** Create a new bilingual text object */
export function newText(value = '') {
  return { es: currentLang === 'es' ? value : '', en: currentLang === 'en' ? value : '' };
}

/** Set text for the current language on a bilingual text object */
export function setText(textObj, value) {
  if (!textObj || typeof textObj === 'string') {
    textObj = { es: '', en: '' };
  }
  textObj[currentLang] = value;
  return textObj;
}

/** Update the toggle button UI to reflect current language */
function updateToggleUI() {
  const toggle = document.getElementById('lang-toggle');
  if (!toggle) return;

  const esLabel = toggle.querySelector('.lang-es');
  const enLabel = toggle.querySelector('.lang-en');
  const slider = toggle.querySelector('.lang-slider');

  if (esLabel && enLabel && slider) {
    if (currentLang === 'es') {
      esLabel.classList.add('active');
      enLabel.classList.remove('active');
      slider.style.transform = 'translateX(0)';
    } else {
      esLabel.classList.remove('active');
      enLabel.classList.add('active');
      slider.style.transform = 'translateX(100%)';
    }
  }
}

/** Initialize toggle UI on load */
export function initLangToggle() {
  const toggle = document.getElementById('lang-toggle');
  if (!toggle) return;

  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    toggleLang();
  });

  updateToggleUI();
}
