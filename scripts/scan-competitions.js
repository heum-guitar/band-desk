import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import admin from 'firebase-admin';

const COMPETITION_SEARCH_QUERIES = [
  '밴드 경연대회 접수 모집',
  '청소년 밴드 경연대회 모집',
  '실용음악 경연대회 밴드 모집',
  '버스킹 대회 밴드 모집',
];

const MULE_COMPETITION_URLS = [
  'https://www.mule.co.kr/bbs/info/contest',
  'https://www.mule.co.kr/bbs/lesson/contest',
];

const VERIFIED_COMPETITION_ITEMS = [
  {
    id: 'search-2057339530',
    sourceType: 'verified',
    status: 'open',
    title: '2026 제5회 광주버스킹월드컵 참가 뮤지션 모집',
    organizer: '광주광역시 동구 / 광주광역시동구문화관광재단',
    date: '2026. 10. 07. ~ 2026. 10. 11.',
    deadline: '2026. 05. 31.',
    venue: '국립아시아문화전당 하늘마당, 5·18민주광장 등 충장로 일원',
    prize: '총상금 2,000만원, 1위 1,000만원, 국내팀 교통비·숙박 지원, 음원 유통 지원',
    url: 'https://buskingworldcup.com/bbs/board.php?bo_table=notice&wr_id=104',
    desc: '만 19세 이상 성인 버스킹 뮤지션 대상. 창작곡·기성곡 모두 가능하며 음악 기반 퍼포먼스 포함 가능. 2025년 32강 진출팀 및 역대 수상자는 참가 불가.',
  },
];

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL
  || 'https://heum-band-default-rtdb.asia-southeast1.firebasedatabase.app';

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDeadlineDate(value) {
  const match = String(value || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
}

function isCompetitionOpen(competition) {
  const deadline = parseDeadlineDate(competition.deadline);
  return !deadline || deadline >= dateKey(new Date());
}

function hashString(value) {
  let hash = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return `search-${Math.abs(hash)}`;
}

function normalizeCompetitionKey(title, url) {
  return `${String(title || '').replace(/\s+/g, '').toLowerCase()}|${String(url || '').split('?')[0]}`;
}

function isOutdatedSearchCompetition(item) {
  if (!String(item?.id || '').startsWith('search-')) return false;
  if (!item.sourcePublishedAt) return true;
  const publishedAt = new Date(item.sourcePublishedAt);
  if (Number.isNaN(publishedAt.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  return publishedAt < cutoff;
}

function hasOnlyPastYear(text) {
  const years = [...String(text || '').matchAll(/\b(20\d{2})\b/g)].map(match => Number(match[1]));
  if (!years.length) return false;
  const currentYear = new Date().getFullYear();
  return years.every(year => year < currentYear);
}

function removeOutdatedCompetitions(items) {
  return (items || [])
    .filter(item => !isOutdatedSearchCompetition(item))
    .filter(item => !hasOnlyPastYear(item.title));
}

function mergeCompetitionItems(items) {
  const seen = new Set();
  return (items || []).filter(item => {
    const key = normalizeCompetitionKey(item.title, item.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripHtml(value) {
  const dom = new JSDOM(String(value || ''));
  return cleanText(dom.window.document.body.textContent || '');
}

function cleanFeedTitle(value) {
  return String(value || '').replace(/\s+-\s+[^-]+$/, '').trim();
}

function toAbsoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return '';
  }
}

async function fetchText(url, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; BandDeskCompetitionScanner/1.0)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMuleCompetitions() {
  const lists = await Promise.allSettled(MULE_COMPETITION_URLS.map(fetchMuleCompetitionList));
  const candidates = lists
    .flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .filter(isRelevantCompetitionResult)
    .slice(0, 12);
  const details = await Promise.allSettled(candidates.map(fetchMuleCompetitionDetail));
  return details
    .map((result, index) => result.status === 'fulfilled' ? result.value : buildCompetitionFromSearchItem(candidates[index]))
    .filter(Boolean);
}

async function fetchMuleCompetitionList(url) {
  const text = await fetchText(url, 9000);
  const doc = new JSDOM(text, { url }).window.document;
  return [...doc.querySelectorAll('a[href*="contest"]')]
    .map(link => {
      const title = cleanText(link.textContent);
      const href = link.getAttribute('href') || '';
      const rowText = cleanText(link.closest('tr, li, div')?.textContent || title);
      return {
        title,
        url: toAbsoluteUrl(href, 'https://www.mule.co.kr'),
        source: '중고악기 뮬',
        publishedAt: '',
        summary: rowText,
      };
    })
    .filter(item => item.title.length > 8 && item.url.includes('mule.co.kr'))
    .filter(item => !/공지|오디션은 공개오디션|페이는 정확하게/.test(item.title));
}

async function fetchMuleCompetitionDetail(item) {
  const text = await fetchText(item.url, 9000);
  const doc = new JSDOM(text, { url: item.url }).window.document;
  const pageText = cleanText(doc.body?.textContent || item.summary);
  return buildCompetitionFromSearchItem({
    ...item,
    summary: pageText.slice(0, 1800),
  });
}

async function fetchCompetitionFeed(query) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  const searchQuery = `${query} after:${dateKey(cutoff)}`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=ko&gl=KR&ceid=KR:ko`;
  const text = await fetchText(rssUrl);
  const doc = new JSDOM(text, { contentType: 'text/xml' }).window.document;
  return [...doc.querySelectorAll('item')].map(item => ({
    title: cleanFeedTitle(item.querySelector('title')?.textContent || ''),
    url: item.querySelector('link')?.textContent || '',
    source: item.querySelector('source')?.textContent || '검색 결과',
    publishedAt: item.querySelector('pubDate')?.textContent || '',
    summary: stripHtml(item.querySelector('description')?.textContent || ''),
  })).filter(isFreshSearchItem).filter(isRelevantCompetitionResult);
}

function buildCompetitionFromSearchItem(item) {
  const combined = `${item.title} ${item.summary}`;
  const deadline = inferDeadline(combined);
  const parsedDeadline = parseDeadlineDate(deadline);
  const sourceType = item.sourceType || (String(item.url || '').includes('mule.co.kr') ? 'mule' : 'search');
  return {
    id: item.id || hashString(`${item.title}|${item.url}`),
    sourceType,
    foundAt: new Date().toISOString(),
    sourcePublishedAt: item.publishedAt || item.sourcePublishedAt || '',
    status: !parsedDeadline || parsedDeadline >= dateKey(new Date()) ? 'open' : 'planned',
    title: item.title || '대회 공고',
    organizer: item.source || item.organizer || '검색 결과',
    date: item.date || inferEventDate(combined) || '원문 확인 필요',
    deadline: item.deadline || deadline || '원문 확인 필요',
    venue: item.venue || inferVenue(combined) || '원문 확인 필요',
    prize: item.prize || inferPrize(combined) || '원문 확인 필요',
    url: item.url || '',
    desc: item.desc || summarizeCompetitionText(combined),
  };
}

function isRelevantCompetitionResult(item) {
  const text = `${item.title} ${item.summary}`;
  const title = String(item.title || '');
  return /밴드|실용음악|버스킹|음악|가요|락|록/i.test(text)
    && /대회|경연|공모|모집|접수|콘테스트/i.test(text)
    && !/모집완료|\[마감\]|\(마감\)|게시중단|임시조치/i.test(title)
    && !hasOnlyPastYear(text);
}

function isFreshSearchItem(item) {
  if (!item.publishedAt) return true;
  const publishedAt = new Date(item.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) return true;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 180);
  return publishedAt >= cutoff;
}

function inferDeadline(text) {
  const matches = findKoreanDates(text);
  const deadlineContext = /(마감|접수|신청|모집|까지|기한|deadline)/i;
  const contextual = matches.find(match => deadlineContext.test(text.slice(Math.max(0, match.index - 20), match.index + 40)));
  return formatFoundDate(contextual || matches[0]);
}

function inferEventDate(text) {
  const matches = findKoreanDates(text);
  const eventContext = /(개최|일시|일정|본선|예선|공연|행사|대회)/i;
  const contextual = matches.find(match => eventContext.test(text.slice(Math.max(0, match.index - 20), match.index + 40)));
  return formatFoundDate(contextual);
}

function findKoreanDates(text) {
  const nowYear = new Date().getFullYear();
  const pattern = /(?:(20\d{2})\s*[년.\-/]\s*)?(\d{1,2})\s*[월.\-/]\s*(\d{1,2})\s*일?/g;
  return [...String(text || '').matchAll(pattern)].map(match => ({
    index: match.index || 0,
    year: match[1] || String(nowYear),
    month: match[2],
    day: match[3],
  }));
}

function formatFoundDate(found) {
  if (!found) return '';
  return `${found.year}. ${String(found.month).padStart(2, '0')}. ${String(found.day).padStart(2, '0')}`;
}

function inferVenue(text) {
  const match = String(text || '').match(/(?:장소|공연장|개최지|venue)\s*[:：]?\s*([^.,\n]{2,28})/i);
  return match ? match[1].trim() : '';
}

function inferPrize(text) {
  const match = String(text || '').match(/(?:상금|시상|혜택|prize)\s*[:：]?\s*([^.,\n]{2,42})/i);
  return match ? match[1].trim() : '원문 확인 필요';
}

function summarizeCompetitionText(text) {
  const cleaned = cleanText(text);
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned || '원문에서 세부 내용을 확인하세요.';
}

async function searchCurrentCompetitions() {
  const verified = VERIFIED_COMPETITION_ITEMS.map(item => ({ ...item, foundAt: new Date().toISOString() })).filter(isCompetitionOpen);
  const [mule, feeds] = await Promise.all([
    fetchMuleCompetitions().catch(error => {
      console.warn('Mule scan failed:', error.message);
      return [];
    }),
    Promise.allSettled(COMPETITION_SEARCH_QUERIES.map(fetchCompetitionFeed)),
  ]);
  const newsItems = feeds.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const items = [...verified, ...mule, ...newsItems];
  const seen = new Set();
  return removeOutdatedCompetitions(items)
    .map(item => item.status ? item : buildCompetitionFromSearchItem(item))
    .filter(Boolean)
    .filter(isCompetitionOpen)
    .filter(item => {
      const key = normalizeCompetitionKey(item.title, item.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT secret is required');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error.message}`);
  }
}

async function saveCompetitionsToFirebase(items) {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(parseServiceAccount()),
      databaseURL: DATABASE_URL,
    });
  }
  const payload = {
    items: mergeCompetitionItems(items),
    savedAt: Date.now(),
    updatedAt: new Date().toISOString(),
    source: 'github-actions',
  };
  await admin.database().ref('competitions').set(payload);
  return payload;
}

try {
  const competitions = await searchCurrentCompetitions();
  const payload = await saveCompetitionsToFirebase(competitions);
  console.log(`Saved ${payload.items.length} competitions to Firebase at ${payload.updatedAt}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
