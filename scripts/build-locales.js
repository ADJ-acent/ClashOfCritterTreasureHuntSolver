"use strict";
/* ============================================================================
   Prerender one static page per locale, plus the sitemap.  Run: npm run build:locales

   Why this exists
   ---------------
   The app decides its language at runtime, but Googlebot crawls with an English
   Accept-Language and no localStorage, so it only ever saw the English page, and there
   was no other URL to file a translation under anyway. Google works out a page's
   language from the visible text it is served, so the fix has to put translated text in
   the HTML at a distinct URL. That is all this script does: index.html in, /de/index.html
   and friends out, each one already in its language before a line of JS runs.

   How it works
   ------------
   index.html IS the template. It stays hand-edited and doubles as the English page and
   the x-default, and it is never written by this script. For each of the other locales we
   clone it and apply exactly the transform applyStaticI18n() applies at runtime (the same
   data-i18n / -html / -title attributes, the same I18N table out of the shipped i18n.js),
   plus the head metadata the runtime cannot usefully set: title, description, canonical,
   Open Graph, JSON-LD. The reciprocal hreflang block is inherited from the template
   unchanged, so it cannot fall out of sync.

   The transform is surgical, not a render: no scripts run, the board stays empty, nothing
   is timestamped. Same input, same bytes out, which is what lets CI diff the result and
   fail a PR whose generated pages are stale.
   ============================================================================ */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const BASE = "https://adj-acent.github.io/ClashOfCritterTreasureHuntSolver/";

// Bump when the pages meaningfully change. NOT a live date: the CI staleness check diffs
// this script's output, and a today() here would make every build dirty by the next day.
const LASTMOD = "2026-07-13";

// og:locale wants a territory. It is a weak signal and these are just the plausible
// majority market for each language; nothing else depends on them.
const OG_LOCALE = {
  en: "en_US", "zh-Hans": "zh_CN", "zh-Hant": "zh_TW", es: "es_ES", pt: "pt_BR",
  fr: "fr_FR", de: "de_DE", ru: "ru_RU", ja: "ja_JP", ko: "ko_KR", th: "th_TH",
  id: "id_ID", it: "it_IT", vi: "vi_VN", pl: "pl_PL", nl: "nl_NL",
};

// One source of truth for the strings: the same i18n.js the browser loads.
const { LANGS, I18N } = new Function(
  fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8") + "\nreturn { LANGS, I18N };"
)();

const urlFor = code => (code === "en" ? BASE : BASE + code + "/");

// No fallback to English here on purpose. A missing key would silently ship an English
// string inside an otherwise translated page, which is worse than a failed build.
function t(code, key) {
  const v = I18N[code] && I18N[code][key];
  if (v == null) throw new Error(`i18n.js: ${code} is missing "${key}"`);
  if (typeof v === "object") throw new Error(`i18n.js: "${key}" is plural; static chrome cannot be`);
  return v;
}

const attr = (doc, sel, name, val) => {
  const el = doc.querySelector(sel);
  if (!el) throw new Error(`index.html: no element matches ${sel}`);
  el.setAttribute(name, val);
};

/* ---------- One locale page ---------- */
function buildPage(template, code) {
  const dom = new JSDOM(template);                  // parse only; no scripts run
  const doc = dom.window.document;
  const url = urlFor(code);

  // The pin. detectLang() reads this and lets it outrank a stored preference, so the page
  // renders in the language its URL promises even for a visitor who once picked another.
  doc.documentElement.setAttribute("lang", code);
  doc.documentElement.setAttribute("data-pinned-lang", code);

  /* --- head --- */
  doc.querySelector("title").textContent = t(code, "app.pageTitle");
  attr(doc, 'meta[name="description"]', "content", t(code, "meta.description"));
  attr(doc, 'link[rel="canonical"]', "href", url);
  attr(doc, 'meta[property="og:title"]', "content", t(code, "app.pageTitle"));
  attr(doc, 'meta[property="og:description"]', "content", t(code, "meta.description"));
  attr(doc, 'meta[property="og:url"]', "content", url);
  attr(doc, 'meta[name="twitter:title"]', "content", t(code, "app.pageTitle"));
  attr(doc, 'meta[name="twitter:description"]', "content", t(code, "meta.description"));

  // og:locale has no slot in the English template (og defaults to en_US), so add one.
  const ogLocale = doc.createElement("meta");
  ogLocale.setAttribute("property", "og:locale");
  ogLocale.setAttribute("content", OG_LOCALE[code]);
  doc.querySelector('meta[property="og:type"]').before(ogLocale);

  const ld = doc.querySelector('script[type="application/ld+json"]');
  const data = JSON.parse(ld.textContent);
  data.name = t(code, "app.pageTitle");
  data.description = t(code, "meta.description");
  data.url = url;
  data.inLanguage = code;                       // this page is one language, not all sixteen
  ld.textContent = "\n" + JSON.stringify(data, null, 2) + "\n";

  // Sibling assets now live one level up. Absolute and protocol-relative srcs (the OG image,
  // the analytics beacon) must be left alone.
  const relative = v => v && !/^(https?:)?\/\//.test(v);
  doc.querySelectorAll("script[src], link[href]").forEach(el => {
    const name = el.tagName === "SCRIPT" ? "src" : "href";
    const v = el.getAttribute(name);
    if (el.getAttribute("rel") === "alternate" || el.getAttribute("rel") === "canonical") return;
    if (relative(v)) el.setAttribute(name, "../" + v);
  });

  /* --- body: the same swap applyStaticI18n() does at runtime --- */
  doc.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(code, el.dataset.i18n); });
  doc.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(code, el.dataset.i18nHtml); });
  doc.querySelectorAll("[data-i18n-title]").forEach(el => { el.setAttribute("title", t(code, el.dataset.i18nTitle)); });

  // The picker: point every link back up a level, and mark this page's own entry, so the
  // menu is already correct with JS off and initLangPicker() has nothing to change.
  doc.querySelectorAll("#langMenu a[data-lang]").forEach(a => {
    const href = a.getAttribute("href");
    a.setAttribute("href", "../" + (href === "./" ? "" : href));
    if (a.dataset.lang === code) a.setAttribute("aria-current", "true");
  });
  const autonym = LANGS.find(([c]) => c === code)[1];
  doc.querySelector("#langCurrent").textContent = autonym;

  return dom.serialize() + "\n";
}

/* ---------- Sitemap ---------- */
function buildSitemap() {
  const alts = ["x-default"].concat(LANGS.map(([c]) => c))
    .map(c => `    <xhtml:link rel="alternate" hreflang="${c}" href="${urlFor(c === "x-default" ? "en" : c)}" />`)
    .join("\n");

  const urls = LANGS.map(([code]) => [
    "  <url>",
    `    <loc>${urlFor(code)}</loc>`,
    `    <lastmod>${LASTMOD}</lastmod>`,
    "    <changefreq>monthly</changefreq>",
    `    <priority>${code === "en" ? "1.0" : "0.8"}</priority>`,
    alts,                      // every entry lists the whole cluster, itself included
    "  </url>",
  ].join("\n")).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!-- Generated by scripts/build-locales.js. Do not edit by hand. -->',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

/* ---------- Go ---------- */
const template = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const written = [];

for (const [code] of LANGS) {
  if (code === "en") continue;                  // the root is the English page; never rewrite it
  const dir = path.join(ROOT, code);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), buildPage(template, code), "utf8");
  written.push(code + "/");
}

fs.writeFileSync(path.join(ROOT, "sitemap.xml"), buildSitemap(), "utf8");
console.log(`built ${written.length} locale pages: ${written.join(" ")}`);
console.log(`sitemap.xml: ${LANGS.length} URLs`);
