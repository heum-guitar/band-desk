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

const BAND_RELEVANCE_PATTERN = /(밴드|실용\s*음악|버스킹|인디|록|락|음악\s*(?:경연|대회|콘테스트)|콘테스트)/i;
const COMPETITION_INTENT_PATTERN = /(대회|경연|공모전?|모집|접수|콘테스트|페스티벌|오디션)/i;
const CLOSED_PATTERN = /(모집완료|\[마감\]|\(마감\)|마감\s*완료|접수\s*종료|게시중단|임시조치)/i;
const NEWS_SOURCE_PATTERN = /(뉴스|신문|일보|방송|투데이|데일리|타임즈|저널|헤럴드|경제|매일|연합|프레스|기자|미디어|매거진|포스트|서울경제|이데일리|한국경제|머니투데이|뉴시스|아시아경제|조선|중앙|동아|한겨레|경향|국민일보|문화일보|세계일보|부산일보|매일경제|파이낸셜)/i;

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function todayKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = type => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseDeadlineDate(value) {
  const matches = findKoreanDates(value);
  if (!matches.length) return null;
  return matches[0].key;
}

function isCompetitionOpen(competition) {
  const deadline = parseDeadlineDate(competition.deadline);
  return !deadline || deadline >= todayKey();
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
  if (item?.sourceType && item.sourceType !== 'search') return false;
  if (!String(item?.id || '').startsWith('search-')) return false;
  if (!item.sourcePublishedAt) return false;
  const publishedAt = new Date(item.sourcePublishedAt);
  if (Number.isNaN(publishedAt.getTime())) return false;
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

function cleanMultilineText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => cleanText(line))
    .filter(Boolean)
    .join('\n');
}

function cleanFeedTitle(value) {
  return String(value || '').replace(/\s+-\s+[^-]+$/, '').trim();
}

function knownValue(value) {
  const text = cleanText(value);
  return text && text !== '원문 확인 필요' ? text : '';
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
  const pageText = extractPageText(doc);
  return buildCompetitionFromSearchItem({
    ...item,
    summary: `${item.summary}\n${pageText}`.slice(0, 3200),
  });
}

async function fetchSearchCompetitionDetail(item) {
  const text = await fetchText(item.url, 9000);
  const doc = new JSDOM(text, { url: item.url }).window.document;
  const pageText = extractPageText(doc);
  return buildCompetitionFromSearchItem({
    ...item,
    summary: `${item.summary}\n${pageText}`.slice(0, 3600),
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
  })).filter(isFreshSearchItem).filter(isRelevantCompetitionResult).filter(item => !isNewsArticleSource(item));
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
    status: !parsedDeadline || parsedDeadline >= todayKey() ? 'open' : 'planned',
    title: item.title || '대회 공고',
    organizer: item.source || item.organizer || '검색 결과',
    date: knownValue(item.date) || inferEventDate(combined) || '원문 확인 필요',
    deadline: knownValue(item.deadline) || deadline || '원문 확인 필요',
    venue: knownValue(item.venue) || inferVenue(combined) || '원문 확인 필요',
    prize: knownValue(item.prize) || inferPrize(combined) || '원문 확인 필요',
    url: item.url || '',
    desc: knownValue(item.desc) || summarizeCompetitionText(combined),
  };
}

function isRelevantCompetitionResult(item) {
  const text = `${item.title} ${item.summary}`;
  const title = String(item.title || '');
  return BAND_RELEVANCE_PATTERN.test(text)
    && COMPETITION_INTENT_PATTERN.test(text)
    && !CLOSED_PATTERN.test(title)
    && !hasOnlyPastYear(text);
}

function isNewsArticleSource(item) {
  const source = String(item.source || '');
  let host = '';
  try {
    host = new URL(item.url || '').hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  return NEWS_SOURCE_PATTERN.test(source) || /news\.google\.com|news\.naver\.com|n\.news\.naver\.com|daum\.net\/v|joins\.com|chosun\.com|donga\.com|hani\.co\.kr|khan\.co\.kr|yna\.co\.kr|newsis\.com|edaily\.co\.kr|mk\.co\.kr|hankyung\.com|mt\.co\.kr|fnnews\.com|asiae\.co\.kr|sedaily\.com/.test(host);
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
  const contextual = matches.filter(match => deadlineContext.test(text.slice(Math.max(0, match.index - 30), match.index + 60)));
  return formatFoundDate(contextual[contextual.length - 1] || matches[0]);
}

function inferEventDate(text) {
  const matches = findKoreanDates(text);
  const eventContext = /(개최|일시|일정|본선|예선|공연|행사|대회)/i;
  const contextual = matches.find(match => eventContext.test(text.slice(Math.max(0, match.index - 20), match.index + 40)));
  return formatFoundDate(contextual);
}

function findKoreanDates(text) {
  const source = String(text || '');
  const currentYear = Number(todayKey().slice(0, 4));
  const matches = [];
  const addMatch = (match, year, month, day) => {
    const parsed = normalizeDateParts(year || currentYear, month, day);
    if (!parsed) return;
    matches.push({
      index: match.index || 0,
      raw: match[0],
      ...parsed,
    });
  };

  for (const match of source.matchAll(/\b(20\d{2})\s*(?:년|[.\-/])\s*(\d{1,2})\s*(?:월|[.\-/])\s*(\d{1,2})\s*일?\b/g)) {
    addMatch(match, match[1], match[2], match[3]);
  }
  for (const match of source.matchAll(/(?<!\d)(\d{1,2})\s*월\s*(\d{1,2})\s*일?/g)) {
    addMatch(match, currentYear, match[1], match[2]);
  }
  for (const match of source.matchAll(/(?<!20\d{2}[.\-/]\s*)(?<!\d)(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\s*[.\-/]\s*\d)/g)) {
    addMatch(match, currentYear, match[1], match[2]);
  }

  const seen = new Set();
  return matches
    .sort((a, b) => a.index - b.index)
    .filter(match => {
      const key = `${match.index}:${match.key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeDateParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2020 || y > 2035 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return {
    year: String(y),
    month: String(m),
    day: String(d),
    key,
    display: `${y}. ${String(m).padStart(2, '0')}. ${String(d).padStart(2, '0')}.`,
  };
}

function inferLabeledValue(text, labels, maxLength) {
  const lines = cleanMultilineText(text).split('\n');
  const labelPattern = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const lineMatch = lines.find(line => new RegExp(`(?:${labelPattern})\\s*[:：]?\\s*\\S`, 'i').test(line));
  if (lineMatch) {
    const value = lineMatch
      .replace(new RegExp(`^.*?(?:${labelPattern})\\s*[:：]?\\s*`, 'i'), '')
      .replace(/\s*(?:문의|접수|주최|주관)\s*[:：].*$/i, '')
      .trim();
    if (value.length >= 2) return value.slice(0, maxLength);
  }

  const compact = cleanText(text);
  const match = compact.match(new RegExp(`(?:${labelPattern})\\s*[:：]?\\s*([^.!?。]{2,${maxLength}})`, 'i'));
  return match ? cleanText(match[1]).slice(0, maxLength) : '';
}

function extractPageText(doc) {
  doc.querySelectorAll('script, style, noscript, iframe, svg, nav, header, footer').forEach(node => node.remove());
  const main = doc.querySelector('article, main, .view, .view_content, .board_view, .board-content, .content, .contents, .post, .entry-content, #content') || doc.body;
  return cleanMultilineText(main?.textContent || '');
}

function formatFoundDate(found) {
  if (!found) return '';
  return found.display;
}

function inferVenue(text) {
  return inferLabeledValue(text, ['장소', '공연장', '개최지', '행사장', 'venue'], 48);
}

function inferPrize(text) {
  return inferLabeledValue(text, ['상금', '시상', '시상내역', '혜택', 'prize'], 72);
}

function summarizeCompetitionText(text) {
  const cleaned = cleanText(
    String(text || '')
      .split('\n')
      .filter(line => !/^(일시|일정|장소|접수|마감|시상|상금|문의)\s*[:：]/.test(line))
      .join(' '),
  );
  return cleaned.length > 160 ? `${cleaned.slice(0, 160)}...` : cleaned || '원문에서 세부 내용을 확인하세요.';
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
  const feedCandidates = feeds.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const feedDetails = await Promise.allSettled(feedCandidates.slice(0, 8).map(fetchSearchCompetitionDetail));
  const newsItems = feedDetails
    .map((result, index) => result.status === 'fulfilled' ? result.value : buildCompetitionFromSearchItem(feedCandidates[index]))
    .filter(Boolean);
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
  if (process.env.DRY_RUN_COMPETITIONS === '1') {
    console.log(JSON.stringify({ count: competitions.length, items: competitions }, null, 2));
    process.exit(0);
  }
  const payload = await saveCompetitionsToFirebase(competitions);
  console.log(`Saved ${payload.items.length} competitions to Firebase at ${payload.updatedAt}`);
  await admin.app().delete();
} catch (error) {
  console.error(error);
  if (admin.apps.length) await admin.app().delete().catch(() => {});
  process.exitCode = 1;
}
