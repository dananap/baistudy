// In-page audits for the design standards (flashcard-frontend/design-standards.md).
// Each returns a list of human-readable offenders, so a failing assertion says
// exactly which element broke which rule.
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/** Selector for everything a person can operate. */
const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="radio"]', '[role="tab"]', '[role="checkbox"]', '[role="link"]',
].join(',');

/** §3 — axe-core against WCAG 2.0–2.2 A/AA. Returns serious/critical violations
 *  (the standard's bar) and the rest separately for reporting. */
export async function axeAudit(page: Page) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const fmt = (v: (typeof res.violations)[number]) =>
    `${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}${v.nodes.length > 4 ? ` …+${v.nodes.length - 4}` : ''}`;
  return {
    blocking: res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map(fmt),
    other: res.violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical').map(fmt),
  };
}

/** §2/§3 — page must not scroll sideways (WCAG 1.4.10 reflow). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** §3 — target size. Interactive elements must be ≥ `min` CSS px in both
 *  dimensions. WCAG exceptions honoured: inline targets inside running text
 *  (display: inline), and checkboxes/radios whose wrapping <label> is the
 *  target. Hidden and disabled controls are skipped. */
export async function smallTargets(page: Page, min: number): Promise<string[]> {
  return page.evaluate(({ sel, min }) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (cs.display === 'inline') continue; // inline-in-text exception
      // Words inside running text (the reader's tappable tokens) fall under the
      // same WCAG exception; they still have to clear the 24px AA minimum.
      const inText = el.parentElement?.closest('p') && /inline/.test(cs.display);
      if (inText) {
        const r0 = el.getBoundingClientRect();
        if (r0.width >= 24 - 0.5 && r0.height >= 24 - 0.5) continue;
      }
      let target: HTMLElement = el;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        target = el.closest('label') ?? el;
      }
      // Text inputs are measured as themselves: tapping a styled wrapper's
      // padding does not focus the input, so the input box is the real target.
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < min - 0.5 || r.height < min - 0.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).placeholder || el.className || el.tagName)
          .toString().trim().replace(/\s+/g, ' ').slice(0, 40);
        out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return out;
  }, { sel: INTERACTIVE, min });
}

/** §5 — nothing below 12px. Checks every element that directly holds visible text. */
export async function tinyText(page: Page, floor = 12): Promise<string[]> {
  return page.evaluate((floor) => {
    const out = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent?.trim();
      if (!text) continue;
      const el = n.parentElement!;
      if (el.closest('.sr-only, [aria-hidden="true"], script, style, noscript')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < floor - 0.01) out.add(`${size}px "${text.slice(0, 30)}" (.${el.className || el.tagName})`);
    }
    return [...out];
  }, floor);
}

/** §3 Language — every visible run of Chinese sits inside an element whose
 *  language is Chinese, so screen readers and fonts switch correctly. */
export async function chineseWithoutLang(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const han = /\p{Script=Han}/u;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      if (!han.test(text)) continue;
      const el = n.parentElement!;
      if (el.closest('[aria-hidden="true"], script, style')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const lang = el.closest('[lang]')?.getAttribute('lang') ?? '';
      if (!/^zh/i.test(lang)) out.add(`"${text.trim().slice(0, 24)}" (.${el.className || el.tagName}, lang=${lang || 'none'})`);
    }
    return [...out];
  });
}

/** §11 — calm copy: no exclamation marks or emoji in the interface. Chinese
 *  content (lang=zh) is exempt: that's study material, not UI copy. */
export async function loudCopy(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    const emoji = /\p{Extended_Pictographic}/u;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      const el = n.parentElement!;
      if (el.closest('[lang^="zh"], script, style, textarea, pre, code, .markdown')) continue;
      if (/!(?!=)/.test(text) || emoji.test(text)) out.add(`"${text.trim().slice(0, 40)}"`);
    }
    return [...out];
  });
}

/** §3 — there is exactly one h1. */
export async function h1Count(page: Page): Promise<number> {
  return page.locator('h1:visible').count();
}

/** §2 — inputs are ≥ 16px so iOS doesn't zoom on focus. */
export async function smallInputs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]), textarea, select'))
      .filter((el) => el.getBoundingClientRect().width > 0)
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
      .map((el) => `${el.tagName.toLowerCase()}#${el.id || '?'} ${getComputedStyle(el).fontSize}`),
  );
}

/** §2 — keyboard hints must not show on touch devices. */
export async function visibleKbdHints(page: Page): Promise<number> {
  return page.locator('.kbd-hint:visible').count();
}

/** §3 — WCAG 2.4.7/2.4.11: Tab through the page; every focused element must
 *  draw a visible indicator and must not be entirely hidden behind sticky or
 *  fixed UI (tab bar, action bars, top bars). */
export async function focusProblems(page: Page, maxStops = 40): Promise<string[]> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press('Tab');
    const res = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      el.scrollIntoView({ block: 'nearest' });
      const name = (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
      const key = `${el.tagName}:${name}:${el.getBoundingClientRect().top}`;
      // Indicator: own outline/box-shadow, or the field wrapper's ring.
      const ring = (e: Element | null) => {
        if (!e) return false;
        const cs = getComputedStyle(e);
        return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow !== 'none' && cs.boxShadow !== '');
      };
      const visibleIndicator = ring(el) || ring(el.closest('.field__control, .composer'));
      // Obscured: none of five sample points hit the element itself.
      const r = el.getBoundingClientRect();
      const pts = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]
        .map(([fx, fy]) => [r.left + r.width * fx!, r.top + r.height * fy!] as const)
        .filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
      const hit = pts.some(([x, y]) => {
        const at = document.elementFromPoint(x, y);
        return !!at && (at === el || el.contains(at) || at.contains(el));
      });
      return { key, name, tag: el.tagName.toLowerCase(), visibleIndicator, obscured: pts.length === 0 || !hit };
    });
    if (!res) continue;
    if (seen.has(res.key)) break; // wrapped around
    seen.add(res.key);
    if (!res.visibleIndicator) out.push(`no focus indicator: ${res.tag} "${res.name}"`);
    if (res.obscured) out.push(`focus obscured: ${res.tag} "${res.name}"`);
  }
  return out;
}

/** §12 — cumulative layout shift since navigation (buffered observer). */
export async function cls(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve) => {
    let total = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!e.hadRecentInput) total += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
    setTimeout(() => resolve(total), 300);
  }));
}
