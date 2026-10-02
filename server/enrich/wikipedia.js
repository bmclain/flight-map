// One representative photo per aircraft type, taken from the lead image of
// the type's English Wikipedia article (Wikimedia Commons, freely licensed).
import { fetchJson } from '../util/fetch.js';

const API = 'https://en.wikipedia.org/w/api.php';
const IMAGE_WIDTH = 1280;

const stripHtml = (s) =>
  s
    ?.replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;

function apiUrl(params) {
  const q = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
  return `${API}?${q}`;
}

/** Lead image file name of an article (follows redirects), or null. */
export async function articleImage(title, { fetchImpl = fetch } = {}) {
  const json = await fetchJson(
    apiUrl({ titles: title, redirects: '1', prop: 'pageimages|info', piprop: 'name', inprop: 'url' }),
    { fetchImpl },
  );
  const page = json?.query?.pages?.[0];
  if (!page || page.missing || !page.pageimage) return null;
  return { file: page.pageimage, article: page.title, articleUrl: page.fullurl ?? null };
}

/** Best-matching article for a free-text query (e.g. "Cessna 525 CitationJet"). */
export async function searchArticleImage(query, { fetchImpl = fetch } = {}) {
  const json = await fetchJson(
    apiUrl({
      generator: 'search',
      gsrsearch: `${query} aircraft`,
      gsrlimit: '1',
      gsrnamespace: '0',
      prop: 'pageimages|info',
      piprop: 'name',
      inprop: 'url',
    }),
    { fetchImpl },
  );
  const page = json?.query?.pages?.[0];
  if (!page?.pageimage) return null;
  return { file: page.pageimage, article: page.title, articleUrl: page.fullurl ?? null };
}

/** Scaled image URL plus author / licence for a Commons file. */
export async function fileInfo(file, { fetchImpl = fetch, width = IMAGE_WIDTH } = {}) {
  const json = await fetchJson(
    apiUrl({ titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: String(width) }),
    { fetchImpl },
  );
  const info = json?.query?.pages?.[0]?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata ?? {};
  return {
    imageUrl: info.thumburl || info.url,
    mime: info.mime ?? null,
    descriptionUrl: info.descriptionurl ?? null,
    artist: stripHtml(meta.Artist?.value),
    license: stripHtml(meta.LicenseShortName?.value),
  };
}

/**
 * Find a type photo. Tries the curated article title first, then a search.
 * Returns null when nothing suitable exists (e.g. only a diagram).
 */
export async function findTypeImage({ title, query }, opts = {}) {
  let page = title ? await articleImage(title, opts) : null;
  if (!page && query) page = await searchArticleImage(query, opts);
  if (!page || /\.(svg|gif)$/i.test(page.file)) return null;
  const info = await fileInfo(page.file, opts);
  if (!info?.imageUrl) return null;
  return { ...info, article: page.article, articleUrl: page.articleUrl, file: page.file };
}
